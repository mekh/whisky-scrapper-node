import { Injectable, Logger } from '@nestjs/common';

import { ScrapeConfig } from '~config';
import type { FlavorConfidence } from '~types';

import { LLM_FLAVOR_TAGS } from '../normalize/brand-info.constants';
import { LlmBatchRunner } from './llm-batch.runner';
import { LlmClientService } from './llm-client.service';

import type { LlmFlavorCandidate } from './llm.interfaces';

const MAX_TOKENS = 8192;
const CHUNK_SIZE = 40;

/**
 * How much store description text to send per item. Descriptions run to
 * thousands of characters of marketing prose whose first sentences carry
 * whatever tasting notes exist; the cap keeps a 40-item chunk inside the
 * completion budget.
 */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * Model instruction for flavor classification. The tag list is inlined rather
 * than interpolated so the prompt reads as one literal, which means it must be
 * edited together with `LLM_FLAVOR_TAGS`
 * (`normalize/brand-info.constants.ts`) — that constant is what the answer is
 * filtered against, so a tag named here but missing there is silently dropped.
 *
 * The "answer unknown rather than guess" instruction is the point of this
 * prompt, not a caveat: the tags drive the report's exclude filter, so a
 * plausible-but-wrong tag on an unrecognized bottling is worse than no tag at
 * all.
 *
 * **Peat and smoke are no longer in the list, and the prompt says why.** They
 * come from a curated database keyed on the producer, because a model asked
 * for a distillery's house style answers from the semantic neighbourhood of
 * its name — which is how `Tobermory`, an unpeated malt, was told it tasted of
 * `Ledaig`, its peated sibling from the same site. Reporting them is not a
 * judgement call the model gets to make. `{items}` is the numbered listing.
 */
const PROMPT =
  `You are a whisky flavor classifier. For each product below, determine its
flavor profile using ONLY well-established, publicly known characteristics of
that exact product or its distillery's house style. Never infer a flavor from
the words in the name.

Return ONLY a JSON array, one object per input line, in the same order.
Fields of each object:
- "confidence": "high" when you recognize this specific product or its
  distillery well enough to state its flavor profile; "low" when you have only
  a partial or general idea; "unknown" when you do not recognize the product or
  its distillery at all
- "flavor_tags": an array drawn ONLY from this fixed list — sherry,
  bourbon-cask, vanilla, honey, fruity, chocolate, spicy, floral, citrus,
  nutty, caramel, oak, maritime. Return an empty array together with "unknown"
  confidence rather than inventing, translating or guessing a tag.

Never return a tag outside that list. Answering "unknown" with an empty array
is always safe and is preferred over guessing.

Peat and smoke are NOT on the list and must never be reported, whatever you
believe about the whisky. They are determined by a curated producer database,
not by this classification, and any peat or smoke tag you return is discarded.
Do not mention them, do not substitute a near synonym for them, and do not let
a peated character change which of the thirteen tags above you choose.

Each input line gives the product name followed by whatever is already known
about it: the distillery and region come from the curated database and are
reliable, while the type, country and the store's description come from the
shop's own listing. Use the distillery to identify the whisky. Do not treat
marketing prose as a statement of fact about the flavor.

Products:
{items}
`;

/**
 * One LLM-returned classification object.
 */
interface LlmFlavorInfo {
  confidence?: unknown;
  flavor_tags?: unknown;
}

/**
 * LLM flavor classification against a closed vocabulary.
 *
 * It exists because the deterministic keyword pass can only find a flavor a
 * listing happens to spell out, which leaves most of the catalogue with no
 * tags at all — and the report's main use is excluding a flavor, which silently
 * fails to exclude anything on an untagged product. Unlike
 * `LlmEnrichmentService`, this pass is about recall over a field no source
 * states, so it is driven by product identity rather than by a missing column.
 *
 * Two guards keep it from making the data worse: every returned tag is filtered
 * against `FLAVOR_TAGS`, and `unknown` confidence forces an empty result — the
 * model is told to use it liberally. Enabled only when the LLM endpoint is
 * configured; any error is swallowed so a failed call never breaks a sync.
 */
@Injectable()
export class LlmFlavorService {
  /**
   * Normalizes the model's confidence field, defaulting anything unexpected to
   * `unknown` — a malformed answer must not become a confident one.
   *
   * @param raw - The `confidence` value as returned.
   * @returns The confidence level to record.
   */
  private static confidence(raw: unknown): FlavorConfidence {
    return raw === 'high' || raw === 'low' ? raw : 'unknown';
  }

  /**
   * Filters the model's tags down to the thirteen it is allowed to report,
   * deduplicated and sorted. Fails closed: anything not in `LLM_FLAVOR_TAGS` —
   * an invented tag, a translated one, a whole sentence — is dropped rather
   * than stored, which is what keeps the open `flavor` lookup table clean.
   *
   * `peated` and `smoky` are absent from that list, so the filter is also the
   * last line of defence for the peat invariant: a model that reports peat
   * anyway, against its instructions, is silently ignored.
   *
   * @param raw - The `flavor_tags` value as returned.
   * @returns The allowed tags, or an empty array when none survive.
   */
  private static allowlist(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const allowed = new Set(LLM_FLAVOR_TAGS);

    const tags = raw
      .map((tag) => String(tag).toLowerCase().trim())
      .filter((tag) => allowed.has(tag));

    return [...new Set(tags)].sort();
  }

  private readonly logger = new Logger(LlmFlavorService.name);

  private readonly client: LlmClientService;

  private readonly config: ScrapeConfig;

  public constructor(client: LlmClientService, config: ScrapeConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Whether the classification pass is configured.
   *
   * @returns True when classification can run.
   */
  public get enabled(): boolean {
    return this.client.enabled;
  }

  /**
   * Classifies a batch of candidates, filling their result slots in place. A
   * no-op when disabled or the batch is empty; never throws.
   *
   * @param candidates - Candidates to classify (mutated in place).
   * @param onProgress - Called after each batch with the running count.
   * @param signal - Optional deadline: once it fires, the batches not yet sent
   *   are skipped and their candidates stay unchecked, to be asked about again
   *   by the next run.
   * @returns Resolves once classification has been attempted.
   */
  public async classify(
    candidates: LlmFlavorCandidate[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.client.enabled || !candidates.length) {
      return;
    }

    await LlmBatchRunner.run(
      candidates,
      CHUNK_SIZE,
      (batch) => this.classifyChunk(batch),
      (error, batch) =>
        this.logger.warn(
          'LLM flavor classification failed for %d item(s): %s',
          batch.length,
          error instanceof Error ? error.message : error,
        ),
      onProgress,
      { concurrency: this.config.llmConcurrency, signal },
    );
  }

  /**
   * Sends one chunk to the model and merges the classifications it returns.
   *
   * @param batch - Candidates of this chunk (mutated in place).
   * @returns Resolves once the chunk has been merged.
   * @throws {Error} When the call fails — the runner decides whether to retry
   *   the chunk in halves or give up on it.
   */
  private async classifyChunk(batch: LlmFlavorCandidate[]): Promise<void> {
    const listing = batch
      .map((item, index) => `${index + 1}. ${this.describe(item)}`)
      .join('\n');

    const parsed = await this.client.askJsonArray(
      PROMPT.replace('{items}', listing),
      MAX_TOKENS,
      {
        model: this.config.llmFlavorModel,
        reasoning: this.config.llmFlavorReasoning,
      },
    );

    batch.forEach((item, index) => this.merge(item, parsed[index]));
  }

  /**
   * Renders one candidate as a single prompt line: the name plus whatever
   * grounding is available.
   *
   * @param item - The candidate to render.
   * @returns The prompt line for this item.
   */
  private describe(item: LlmFlavorCandidate): string {
    const bits = [item.name];

    if (item.distillery) {
      bits.push(`distillery: ${item.distillery}`);
    }

    if (item.region) {
      bits.push(`region: ${item.region}`);
    }

    if (item.whiskyType) {
      bits.push(`type: ${item.whiskyType}`);
    }

    if (item.country) {
      bits.push(`country: ${item.country}`);
    }

    const description = this.description(item);

    if (description) {
      bits.push(`description: ${description}`);
    }

    return bits.join(' | ');
  }

  /**
   * Extracts the store's description text for a candidate, truncated. Reads the
   * dedicated field first, then `rawAttrs.description` — where the zakaz and
   * okwine adapters already put the store's own text, at no extra request cost.
   *
   * @param item - The candidate to read.
   * @returns The description text, or null when the item carries none.
   */
  private description(item: LlmFlavorCandidate): string | null {
    const raw = item.description ?? item.rawAttrs?.description;

    return typeof raw === 'string' && raw
      ? raw.slice(0, MAX_DESCRIPTION_CHARS)
      : null;
  }

  /**
   * Merges one classification object into a candidate. Sets the checked flag
   * only for an answer that was actually present, so a short response leaves
   * the missing items to be retried rather than recorded as misses.
   *
   * A tag the producer's curated house style forbids is dropped here rather
   * than argued about in the prompt. The knowledge base is the authority, the
   * model is evidence, and a post-filter is how that ordering is enforced
   * without spending tokens explaining it per item.
   *
   * @param item - The candidate to fill (mutated in place).
   * @param raw - The classification for this candidate, if any.
   */
  private merge(item: LlmFlavorCandidate, raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }

    const info = raw as LlmFlavorInfo;
    const confidence = LlmFlavorService.confidence(info.confidence);

    const forbidden = new Set(item.forbiddenTags ?? []);

    item.llmFlavorConfidence = confidence;
    item.llmFlavorTags = confidence === 'unknown'
      ? []
      : LlmFlavorService.allowlist(info.flavor_tags)
        .filter((tag) => !forbidden.has(tag));

    item.llmFlavorChecked = true;
  }
}
