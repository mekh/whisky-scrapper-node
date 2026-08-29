import { Injectable, Logger } from '@nestjs/common';

import { ScrapeConfig } from '~config';
import { FactSource, ProductFactField } from '~enums';
import type { ProductSnapshot } from '~types';

import { LlmBatchRunner } from './llm-batch.runner';
import { LlmClientService } from './llm-client.service';

const MAX_TOKENS = 8192;
const CHUNK_SIZE = 40;

/**
 * Model instruction (ported from the Python `llm._PROMPT`, then translated —
 * prompts are English-only). `country` must still come back **in Ukrainian**:
 * the persist step resolves it against `country.nameUa`, so the value is a
 * lookup key, not prose. `{items}` is the numbered listing.
 */
const PROMPT =
  `You are a whisky expert. Determine the characteristics of each product name
below. Return ONLY a JSON array, one object per input line, in the same order.
Fields of each object:
- "age_years": the age statement in whole years, or null
- "abv": the alcohol by volume percent as a number, or null
- "volume_ml": the bottle volume in millilitres, or null
- "whisky_type": one of "single malt", "blend", "bourbon", "rye", "grain",
  "tennessee", "malt" — or null when it cannot be determined
- "country": the country of origin, written in Ukrainian ("Шотландія",
  "Ірландія", "США", "Японія", "Канада", "Індія", "Тайвань", "Уельс",
  "Англія", ...), or null

The product names are scraped from Ukrainian retail sites, so they mix Latin
brand names with Cyrillic descriptors.

Product names:
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
}

/**
 * LLM fallback for snapshots the deterministic pass could not fully resolve.
 * Enabled only when the LLM endpoint is configured; any error is swallowed so
 * a failed call never breaks a sync. Results are cached by the caller (the
 * product's own columns), so each product is LLM-processed at most once.
 */
@Injectable()
export class LlmEnrichmentService {
  private readonly logger = new Logger(LlmEnrichmentService.name);

  private readonly client: LlmClientService;

  private readonly config: ScrapeConfig;

  public constructor(client: LlmClientService, config: ScrapeConfig) {
    this.client = client;
    this.config = config;
  }

  /**
   * Whether the LLM fallback is configured.
   *
   * @returns True when enrichment can run.
   */
  public get enabled(): boolean {
    return this.client.enabled;
  }

  /**
   * Fills missing fields on a batch of snapshots via one LLM call. A no-op
   * when disabled or the batch is empty; never throws.
   *
   * @param snaps - Snapshots to enrich (mutated in place).
   * @param signal - Optional deadline: once it fires, the chunks not yet sent
   *   are skipped and their snapshots keep their gaps for the next run.
   * @returns Resolves once enrichment has been attempted.
   */
  public async enrich(
    snaps: ProductSnapshot[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.client.enabled || !snaps.length) {
      return;
    }

    await LlmBatchRunner.run(
      snaps,
      CHUNK_SIZE,
      (batch) => this.enrichChunk(batch),
      (error, batch) =>
        this.logger.warn(
          'LLM enrichment failed for %d item(s): %s',
          batch.length,
          error instanceof Error ? error.message : error,
        ),
      undefined,
      { concurrency: this.config.llmConcurrency, signal },
    );
  }

  /**
   * Sends one chunk to the model and merges the characteristics it returns.
   *
   * @param snaps - Snapshots of this chunk (mutated in place).
   * @returns Resolves once the chunk has been merged.
   * @throws {Error} When the call fails — the runner decides whether to retry
   *   the chunk in halves or give up on it.
   */
  private async enrichChunk(snaps: ProductSnapshot[]): Promise<void> {
    const listing = snaps
      .map((snap, index) => `${index + 1}. ${snap.name}`)
      .join('\n');

    const parsed = await this.client.askJsonArray(
      PROMPT.replace('{items}', listing),
      MAX_TOKENS,
    );

    snaps.forEach((snap, index) => this.merge(snap, parsed[index]));
  }

  /**
   * Merges one LLM info object into a snapshot, filling only empty fields.
   *
   * Every field this fills is stamped `llm`, which is the lowest-trusted live
   * source: no store and no label stated it, the model recalled it. That stamp
   * is what lets a later store's spec page correct the answer, and what lets
   * the review screen list the facts nothing has ever confirmed.
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
      snap.factSources[ProductFactField.AGE] = FactSource.LLM;
    }

    if (snap.abv === null && typeof info.abv === 'number') {
      snap.abv = info.abv;
      snap.factSources[ProductFactField.ABV] = FactSource.LLM;
    }

    if (snap.volumeMl === null && typeof info.volume_ml === 'number') {
      snap.volumeMl = Math.trunc(info.volume_ml);
      snap.factSources[ProductFactField.VOLUME] = FactSource.LLM;
    }

    if (snap.whiskyType === null && info.whisky_type) {
      snap.whiskyType = String(info.whisky_type).toLowerCase();
      snap.factSources[ProductFactField.TYPE] = FactSource.LLM;
    }

    if (snap.country === null && info.country) {
      snap.country = String(info.country);
      snap.factSources[ProductFactField.COUNTRY] = FactSource.LLM;
    }
  }
}
