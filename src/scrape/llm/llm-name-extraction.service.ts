import { Injectable, Logger } from '@nestjs/common';

import { ProductNameUtils } from '~utils';

import { LlmBatchRunner } from './llm-batch.runner';
import { LlmClientService } from './llm-client.service';

import type { LlmNameCandidate } from './llm.interfaces';

const MAX_TOKENS = 8192;
const CHUNK_SIZE = 40;
const MIN_NAME_LENGTH = 2;

/**
 * Model instruction. The Ukrainian words below are quoted **input data** —
 * the literal tokens the model has to recognise in the scraped names — not
 * instruction text; the instruction itself is English (`llm-prompt-language`).
 * `{items}` is the numbered listing.
 */
const PROMPT =
  `You are a whisky expert. The product names below are scraped from Ukrainian
retail sites, so they mix Latin brand names with Cyrillic descriptors. For
each one, return ONLY the brand and the expression (product line) — the part
that identifies the drink itself.

REMOVE from your answer:
- the age statement, including a bare age number ("12yo", "12 років",
  "3 уо", and "Glenfiddich 12" -> "Glenfiddich",
  "Chivas Regal 18" -> "Chivas Regal");
- the ABV ("40%", "46,3%");
- the volume ("0,7л", "700 мл");
- packaging descriptions ("в коробці", "в тубусі", "подарункова упаковка",
  "gift box");
- the whisky type and region ("Blended Scotch Whisky", "Single Malt",
  "Bourbon", "Welsh", "віскі односолодовий", "бурбон", "шотландський").

KEEP in your answer:
- a type or region word that is part of the brand or the expression itself
  ("Highland Park", "Islay Mist", "Speyside Distillery", "Wild Turkey
  American Honey");
- a cask or finish the type word qualifies — "Bushmills Bourbon Finish" and
  "Speyburn Bourbon Cask" name the maturation, not the category, so
  "Bourbon" stays;
- a number that is part of the name rather than the age
  ("Label 5", "Maker's Mark 46", "Wild Turkey 101", "Glenfiddich VAT 01").

RULES:
- invent nothing and translate nothing — use ONLY words present in the input
  line;
- when the name is given in two scripts ("Крагганмор / Cragganmore"), take the
  Latin variant;
- keep the vintage year ("1968", "2007") and the cask number ("#2230");
- if there is nothing to remove, return the line unchanged.

Return ONLY a JSON array of strings, one per input line, in the same order,
with no explanation.

Product names:
{items}
`;

/**
 * LLM pass that reduces a scraped product name to brand + expression. Runs
 * only for products whose `name` is about to be written for the first time
 * (`product.name` is insert-only), and is chunked because a store's first
 * scrape can bring hundreds of new items at once.
 *
 * Enabled only when the LLM endpoint is configured; every error is swallowed
 * so a failed call degrades to `ProductNameUtils.clean`, never breaking a
 * sync.
 */
@Injectable()
export class LlmNameExtractionService {
  /**
   * Folds a name for comparison: lower-cased, apostrophe variants dropped so
   * `Jefferson's` and `Jeffersons` compare equal.
   *
   * @param value - The name to fold.
   * @returns The folded name.
   */
  private static fold(value: string): string {
    return value.toLowerCase().replace(/['’`´]/g, '');
  }

  private readonly logger = new Logger(LlmNameExtractionService.name);

  private readonly client: LlmClientService;

  public constructor(client: LlmClientService) {
    this.client = client;
  }

  /**
   * Whether the extraction pass is configured.
   *
   * @returns True when extraction can run.
   */
  public get enabled(): boolean {
    return this.client.enabled;
  }

  /**
   * Fills `cleanName` on every candidate whose extracted name passes
   * validation, one LLM call per chunk. A no-op when disabled or the list is
   * empty; never throws.
   *
   * @param items - Candidates to extract names for (mutated in place).
   * @returns Resolves once every chunk has been attempted.
   */
  public async extractNames(items: LlmNameCandidate[]): Promise<void> {
    if (!this.client.enabled || !items.length) {
      return;
    }

    await LlmBatchRunner.run(
      items,
      CHUNK_SIZE,
      (batch) => this.extractChunk(batch),
      (error, batch) =>
        this.logger.warn(
          'Name extraction failed for %d item(s): %s',
          batch.length,
          error instanceof Error ? error.message : error,
        ),
    );
  }

  /**
   * Runs one chunk through the model, merging whatever it returns.
   *
   * @param chunk - The candidates of this chunk (mutated in place).
   * @returns Resolves once the chunk has been merged.
   * @throws {Error} When the call fails — the runner decides whether to retry
   *   the chunk in halves or give up on it.
   */
  private async extractChunk(chunk: LlmNameCandidate[]): Promise<void> {
    const listing = chunk
      .map((item, index) => `${index + 1}. ${item.name}`)
      .join('\n');

    const names = await this.client.askJsonArray(
      PROMPT.replace('{items}', listing),
      MAX_TOKENS,
    );

    chunk.forEach((item, index) => this.merge(item, names[index]));
  }

  /**
   * Merges one returned name into its candidate, rejecting anything that does
   * not validate against the raw name.
   *
   * @param item - The candidate to fill (mutated in place).
   * @param raw - The value the model returned for this candidate, if any.
   */
  private merge(item: LlmNameCandidate, raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }

    const stripped = ProductNameUtils.stripSpecs(raw);
    const candidate = stripped === null
      ? null
      : ProductNameUtils.dropSpecNumbers(stripped, item.name);

    if (candidate && this.isValid(item.name, candidate)) {
      item.cleanName = candidate;
    }
  }

  /**
   * Validates an extracted name against the raw one: every alphanumeric token
   * of the candidate must occur in the raw name, case-insensitively. Blocks
   * hallucinated or translated words from reaching the database.
   *
   * A gift set must keep every bottle it names. Told to return the product, the
   * model reads a three-bottle set as one product and answers with the first
   * bottle — and token validation waves that through, because the words it kept
   * are all in the raw name. The deterministic pass keeps the set intact, so
   * rejecting the answer is enough.
   *
   * @param raw - The original scraped name.
   * @param candidate - The name the model proposed.
   * @returns True when the candidate is safe to persist.
   */
  private isValid(raw: string, candidate: string): boolean {
    if (candidate.length < MIN_NAME_LENGTH || candidate.length > raw.length) {
      return false;
    }

    if (ProductNameUtils.hasBundle(raw) && !candidate.includes('+')) {
      return false;
    }

    const haystack = LlmNameExtractionService.fold(raw);
    const tokens = LlmNameExtractionService.fold(candidate)
      .match(/[0-9a-zа-яіїєґ]+/gi) ?? [];

    return tokens.length > 0
      && tokens.every((token) => haystack.includes(token));
  }
}
