import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';

import { ScrapeConfig } from '~config';
import type { ProductSnapshot } from '~types';

const MODEL = 'claude-fable-5';
const MAX_TOKENS = 2048;

// Functional model instruction (must stay Ukrainian so the model returns the
// Ukrainian country names and tags the rest of the pipeline expects). Ported
// verbatim from the Python `llm._PROMPT`; `{items}` is the numbered listing.
const PROMPT =
  `Ти експерт із віскі. Для кожної назви товару визнач характеристики.
Поверни ТІЛЬКИ JSON-масив, по об'єкту на кожен вхідний рядок, у тому ж порядку.
Поля кожного об'єкта:
- "age_years": ціле число років витримки або null
- "abv": число (% об.) або null
- "volume_ml": об'єм у мілілітрах або null
- "whisky_type": один із "single malt", "blend", "bourbon", "rye", "grain",
  "tennessee", "malt" — або null, якщо не визначити
- "country": країна походження українською ("Шотландія", "Ірландія", "США",
  "Японія", "Канада", "Індія", "Тайвань", "Уельс", "Англія", ...) або null
- "flavor_tags": масив смакових профілів (напр. "peated", "sherry", "smoky",
  "vanilla", "fruity"), порожній масив якщо невідомо

Назви товарів:
{items}
`;

/**
 * One LLM-returned characteristics object.
 */
interface LlmInfo {
  age_years?: number | null;
  abv?: number | null;
  volume_ml?: number | null;
  whisky_type?: string | null;
  country?: string | null;
  flavor_tags?: unknown;
}

/**
 * LLM fallback for snapshots the deterministic pass could not fully resolve.
 * Enabled only when `ANTHROPIC_API_KEY` is set; any error is swallowed so a
 * failed LLM call never breaks a sync. Results are cached by the caller (the
 * product's own columns), so each product is LLM-processed at most once.
 */
@Injectable()
export class LlmEnrichmentService {
  private readonly logger = new Logger(LlmEnrichmentService.name);

  private readonly config: ScrapeConfig;

  public constructor(config: ScrapeConfig) {
    this.config = config;
  }

  /**
   * Whether the LLM fallback is configured (has an API key).
   *
   * @returns True when enrichment can run.
   */
  public get enabled(): boolean {
    return Boolean(this.config.anthropicApiKey);
  }

  /**
   * Fills missing fields on a batch of snapshots via one LLM call. A no-op
   * when disabled or the batch is empty; never throws.
   *
   * @param snaps - Snapshots to enrich (mutated in place).
   * @returns Resolves once enrichment has been attempted.
   */
  public async enrich(snaps: ProductSnapshot[]): Promise<void> {
    const apiKey = this.config.anthropicApiKey;

    if (!apiKey || !snaps.length) {
      return;
    }

    try {
      const parsed = await this.ask(apiKey, snaps);

      snaps.forEach((snap, index) => this.merge(snap, parsed[index]));
    } catch (error) {
      this.logger.warn('LLM enrichment failed: %o', error);
    }
  }

  /**
   * Sends the batch to the model and parses the JSON array it returns.
   *
   * @param apiKey - The Anthropic API key.
   * @param snaps - Snapshots to describe.
   * @returns The parsed characteristics, one per snapshot (by index).
   * @throws {Error} When the response is not a JSON array or the call fails.
   */
  private async ask(
    apiKey: string,
    snaps: ProductSnapshot[],
  ): Promise<unknown[]> {
    const client = new Anthropic({ apiKey });
    const listing = snaps
      .map((snap, index) => `${index + 1}. ${snap.name}`)
      .join('\n');

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: PROMPT.replace('{items}', listing) }],
    });

    const block = message.content[0];

    if (!block || block.type !== 'text') {
      throw new Error('LLM returned no text content');
    }

    const text = block.text
      .trim()
      .replace(/^```json/, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    const parsed = JSON.parse(text) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('LLM did not return a JSON array');
    }

    return parsed;
  }

  /**
   * Merges one LLM info object into a snapshot, filling only empty fields.
   *
   * @param snap - The snapshot to fill (mutated in place).
   * @param raw - The LLM info for this snapshot, if any.
   */
  private merge(snap: ProductSnapshot, raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      return;
    }

    const info = raw as LlmInfo;

    if (snap.ageYears === null && typeof info.age_years === 'number') {
      snap.ageYears = Math.trunc(info.age_years);
    }

    if (snap.abv === null && typeof info.abv === 'number') {
      snap.abv = info.abv;
    }

    if (snap.volumeMl === null && typeof info.volume_ml === 'number') {
      snap.volumeMl = Math.trunc(info.volume_ml);
    }

    if (snap.whiskyType === null && info.whisky_type) {
      snap.whiskyType = String(info.whisky_type).toLowerCase();
    }

    if (snap.country === null && info.country) {
      snap.country = String(info.country);
    }

    if (Array.isArray(info.flavor_tags)) {
      const extra = info.flavor_tags.map((tag) => String(tag).toLowerCase());

      snap.flavorTags = [...new Set([...snap.flavorTags, ...extra])].sort();
    }
  }
}
