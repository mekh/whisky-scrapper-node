import { Injectable, Logger } from '@nestjs/common';

import { ScrapeConfig } from '~config';
import { PeatProfile, ProducerKind } from '~enums';

import { LlmBatchRunner } from './llm-batch.runner';
import { LlmClientService } from './llm-client.service';

import type { LlmResearchCandidate } from './llm.interfaces';

const MAX_TOKENS = 8192;

/**
 * Brands per request. Far smaller than the flavour pass's forty: each answer
 * here is a dozen fields rather than a tag list, and a short batch keeps a
 * malformed answer from costing much.
 */
const CHUNK_SIZE = 10;

/**
 * Model instruction for researching an unknown brand.
 *
 * The whole prompt is built around one asymmetry, and it says so twice: a
 * wrong `none` only ever removes peat tags, which the owner sees and can
 * report, while a wrong positive removes a whisky from his filtered results
 * silently. So `unknown` is pushed hard, and the gate downstream withholds
 * anything positive that lacks corroboration regardless of what comes back.
 *
 * `{items}` is the numbered listing of brand names with their sample product
 * names.
 */
const PROMPT =
  `You are researching whisky producers for a curated reference database. For
each brand below, state what is publicly and well established about it. Your
answers are stored as curated facts and are trusted by filters, so accuracy
matters far more than coverage.

Return ONLY a JSON array, one object per input line, in the same order.
Fields of each object:
- "slug": kebab-case ASCII identifier for the producer, stable and lowercase
- "name": the producer's properly spelled display name
- "kind": one of "distillery", "brand", "blend", "bottler"
  - "distillery" — a physical distillery
  - "brand" — a named line whose liquid comes from a distillery you name in
    "parent_slug" (for example Ledaig from Tobermory)
  - "blend" — a blend or vatting with no single distillery of origin, which
    includes most supermarket own labels
  - "bottler" — an independent bottler or retailer range
- "country_code": ISO code. Use "GB-SCT" for Scotland, "GB-ENG" England,
  "GB-WLS" Wales, "IE" Ireland. Never plain "GB".
- "region": Scotland only, one of "campbeltown", "highland", "islay",
  "lowland", "speyside", "islands". Empty otherwise.
- "legal_region": Scotland only, one of the five protected regions —
  "campbeltown", "highland", "islay", "lowland", "speyside". Never "islands":
  the islands are legally Highland.
- "owner": the current owning company, or empty
- "default_type_name": the type EVERY bottling of this producer is, from
  "single malt", "blend", "bourbon", "rye", "grain", "malt",
  "single pot still", "tennessee". Empty for a bottler and for any producer
  whose range spans several types.
- "peat_profile": one of "none", "light", "medium", "heavy", "unknown"
- "parent_slug": for "brand" only, the slug of the distillery it comes from
- "confidence": "high" only when you are certain, otherwise "low"
- "source_urls": URLs you are confident exist and state this, space separated,
  or empty. Never invent one.
- "note": what you were unsure of, and anything you deliberately withheld

The peat level is the field that matters most, and it is asymmetric. A wrong
"none" merely removes smoke tags from a whisky, which somebody will notice. A
wrong "light", "medium" or "heavy" removes a whisky from a peat-exclusion
filter entirely and leaves no trace, so a drinker's favourite silently
disappears. Answer "unknown" whenever you are not confident, and always for a
bottler and for an undisclosed or secret label — "unknown" is the safe answer
and is always acceptable.

Do not guess a distillery for an undisclosed label. Do not average a
distillery's peated and unpeated lines into one profile: those are separate
brands with separate answers.

Brands:
{items}
`;

/**
 * One researched producer object as the model returns it.
 */
interface LlmResearchInfo {
  slug?: unknown;
  name?: unknown;
  kind?: unknown;
  country_code?: unknown;
  region?: unknown;
  legal_region?: unknown;
  owner?: unknown;
  default_type_name?: unknown;
  peat_profile?: unknown;
  parent_slug?: unknown;
  confidence?: unknown;
  source_urls?: unknown;
  note?: unknown;
}

/**
 * Researches brands the knowledge base has never seen.
 *
 * The seed covered the catalogue as it stood; shops add whisky every week, and
 * without this every new brand is unresolved forever — which means it keeps its
 * shop-supplied facts and loses its peat tags, quietly eroding the coverage the
 * seed bought.
 *
 * What it returns is a **proposal**, never a fact. Everything it says goes
 * through the same auto-gate the researched seed went through, and anything
 * that fails is stored `unverified` rather than discarded — so a brand is
 * researched at most once whatever the outcome, and the answer waits on the
 * review screen instead of being paid for again next month.
 */
@Injectable()
export class LlmResearchService {
  /**
   * Reads a value that must belong to a closed set, defaulting to empty.
   *
   * @param raw - The value as returned.
   * @param allowed - The values the database will accept.
   * @returns The value, or an empty string when it is not one of them.
   */
  private static enumOf(raw: unknown, allowed: string[]): string {
    const value = String(raw ?? '').toLowerCase().trim();

    return allowed.includes(value) ? value : '';
  }

  /**
   * Reads a free-text value, trimmed.
   *
   * @param raw - The value as returned.
   * @returns The text, or an empty string.
   */
  private static textOf(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
  }

  private readonly logger = new Logger(LlmResearchService.name);

  private readonly client: LlmClientService;

  private readonly config: ScrapeConfig;

  public constructor(client: LlmClientService, config: ScrapeConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Whether the research pass is configured.
   *
   * @returns True when it can run.
   */
  public get enabled(): boolean {
    return this.client.enabled;
  }

  /**
   * Researches a batch of brands, filling their result slots in place.
   *
   * @param candidates - Brands to research, mutated in place.
   * @param onProgress - Called after each batch with the running count.
   * @returns Resolves once research has been attempted.
   */
  public async research(
    candidates: LlmResearchCandidate[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    if (!this.client.enabled || !candidates.length) {
      return;
    }

    await LlmBatchRunner.run(
      candidates,
      CHUNK_SIZE,
      (batch) => this.researchChunk(batch),
      (error, batch) =>
        this.logger.warn(
          'Brand research failed for %d item(s): %s',
          batch.length,
          error instanceof Error ? error.message : error,
        ),
      onProgress,
      { concurrency: this.config.llmConcurrency },
    );
  }

  /**
   * Sends one chunk to the model and merges what it returns.
   *
   * @param batch - Brands of this chunk, mutated in place.
   * @returns Resolves once merged.
   * @throws {Error} When the call fails; the runner decides whether to halve.
   */
  private async researchChunk(
    batch: LlmResearchCandidate[],
  ): Promise<void> {
    const listing = batch
      .map((item, index) => {
        const samples = item.sampleNames.slice(0, 6).join(' ; ');

        return `${index + 1}. ${item.brand}`
          + `${samples ? ` | products: ${samples}` : ''}`;
      })
      .join('\n');

    const parsed = await this.client.askJsonArray(
      PROMPT.replace('{items}', listing),
      MAX_TOKENS,
      { model: this.config.llmResearchModel, reasoning: false },
    );

    batch.forEach((item, index) => this.merge(item, parsed[index]));
  }

  /**
   * Merges one researched object into a candidate.
   *
   * Every closed-vocabulary field is filtered against the values the database
   * will actually accept, so an invented region or a country code outside the
   * list becomes empty rather than failing an import later. `legal_region` is
   * additionally never allowed to be `islands`, which the column's own CHECK
   * would reject.
   *
   * @param item - The candidate to fill, mutated in place.
   * @param raw - The object for this candidate, if any.
   */
  private merge(item: LlmResearchCandidate, raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }

    const info = raw as LlmResearchInfo;

    const slug = LlmResearchService.textOf(info.slug)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!slug) {
      return;
    }

    const regions = [
      'campbeltown',
      'highland',
      'islay',
      'lowland',
      'speyside',
      'islands',
    ];

    item.result = {
      slug,
      name: LlmResearchService.textOf(info.name) || item.brand,
      kind: LlmResearchService.enumOf(
        info.kind,
        Object.values(ProducerKind),
      ) || ProducerKind.BLEND,
      countryCode: LlmResearchService.textOf(info.country_code).toUpperCase(),
      region: LlmResearchService.enumOf(info.region, regions),
      legalRegion: LlmResearchService.enumOf(
        info.legal_region,
        regions.filter((one) => one !== 'islands'),
      ),
      owner: LlmResearchService.textOf(info.owner),
      defaultTypeName: LlmResearchService.textOf(info.default_type_name),
      peatProfile: LlmResearchService.enumOf(
        info.peat_profile,
        Object.values(PeatProfile),
      ) || PeatProfile.UNKNOWN,
      parentSlug: LlmResearchService.textOf(info.parent_slug),
      confidence: info.confidence === 'high' ? 'high' : 'low',
      sourceUrls: LlmResearchService.textOf(info.source_urls),
      note: LlmResearchService.textOf(info.note),
    };

    item.checked = true;
  }
}
