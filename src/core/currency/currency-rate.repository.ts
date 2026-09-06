import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  CurrencyLatestRate,
  CurrencyRateCoverageRow,
  CurrencyRateGap,
  CurrencyRatePoint,
  CurrencyRateProbe,
  CurrencyRateRow,
} from '~types';
import { ArrayUtils } from '~utils';

import { CurrencyRateEntity } from './currency-rate.entity';

/**
 * How many rates one upsert statement carries. Three parameters per row, so
 * this is nowhere near Postgres' 65 535 parameter ceiling; it is sized for a
 * full-history backfill, where the shared `DEFAULT_CHUNK_SIZE` of 50 would
 * mean four hundred round trips per currency.
 */
const UPSERT_CHUNK_SIZE = 1000;

/**
 * How many `(code, day)` pairs one lookup statement resolves. Two parameters
 * per pair.
 */
const PROBE_CHUNK_SIZE = 500;

/**
 * Resolves each requested `(code, day)` to the rate in force on that day.
 *
 * Rates hang off `currency.id`, while every caller speaks ISO codes, so the
 * currency is joined in rather than matched on the rate row. `LEFT JOIN` both
 * times, and `ON TRUE` on the lateral: a pair naming an unknown currency, or
 * one with no stored rate, comes back with nulls instead of vanishing — the
 * caller has to be able to tell "unconvertible" from "not asked".
 *
 * The `<=` plus `ORDER BY ... DESC LIMIT 1` is the documented fallback: an
 * exact hit wins, and otherwise the most recent earlier day is used and
 * reported as `effectiveOn`. Inside the stored history this never fires — the
 * series is gap-free — so in practice it only covers a day past the last
 * synced one.
 */
const PROBE_SQL = `
  SELECT v.code AS code,
         v.day::text AS "requestedOn",
         r."effectiveOn"::text AS "effectiveOn",
         r.rate::float8 AS rate
  FROM (VALUES %VALUES%) AS v(code, day)
  LEFT JOIN currency c ON c.code = v.code
  LEFT JOIN LATERAL (
    SELECT cr.rate, cr."effectiveOn"
    FROM currency_rate cr
    WHERE cr."currencyId" = c.id
      AND cr."effectiveOn" <= v.day
    ORDER BY cr."effectiveOn" DESC
    LIMIT 1
  ) r ON TRUE`;

@TypeormRepository(CurrencyRateEntity)
export class CurrencyRateRepository extends BaseRepository<CurrencyRateEntity> {
  /**
   * Writes rates, overwriting whatever was stored for the same currency and
   * day.
   *
   * Last write wins, by design: re-running the sync any number of times a day
   * — the script, the cron tick and the manual endpoint, even concurrently —
   * must be safe and must repair a wrong value rather than duplicate it. The
   * unique index on `(currencyId, effectiveOn)` makes that atomic, so no lock
   * or "already synced today" guard is needed anywhere above this method.
   *
   * @param rates - Rows already resolved to a currency id; duplicates within
   *   one call are resolved by the last occurrence.
   * @returns How many rows were written.
   */
  public async upsertMany(rates: CurrencyRateRow[]): Promise<number> {
    const rows = this.dedupe(rates);

    if (!rows.length) {
      return 0;
    }

    const chunks = ArrayUtils.chunkify(rows, UPSERT_CHUNK_SIZE);

    for (const chunk of chunks) {
      await this.upsertChunk(chunk);
    }

    return rows.length;
  }

  /**
   * Resolves a batch of `(code, day)` pairs in as few statements as possible.
   *
   * This is the primitive the conversion path is built on: converting a list
   * of records must cost one query for every distinct pair it mentions, not
   * one per record.
   *
   * @param pairs - The pairs to resolve; duplicates are collapsed first.
   * @returns One probe per distinct pair, in no particular order.
   */
  public async probe(
    pairs: { code: string; day: string }[],
  ): Promise<CurrencyRateProbe[]> {
    const wanted = this.dedupePairs(pairs);

    if (!wanted.length) {
      return [];
    }

    const chunks = ArrayUtils.chunkify(wanted, PROBE_CHUNK_SIZE);
    const found: CurrencyRateProbe[] = [];

    for (const chunk of chunks) {
      const rows = await this.probeChunk(chunk);

      found.push(...rows);
    }

    return found;
  }

  /**
   * Reads one currency's rates over an inclusive day range.
   *
   * @param code - ISO 4217 alphabetic code, upper-case.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The rates ascending by day; empty when none are stored.
   */
  public async findSeries(
    code: string,
    from: string,
    to: string,
  ): Promise<CurrencyRatePoint[]> {
    return await this.query(
      `SELECT cr."effectiveOn"::text AS "effectiveOn",
              cr.rate::float8 AS rate
       FROM currency_rate cr
       JOIN currency c ON c.id = cr."currencyId"
       WHERE c.code = $1
         AND cr."effectiveOn" BETWEEN $2::date AND $3::date
       ORDER BY cr."effectiveOn" ASC`,
      [code, from, to],
    ) as CurrencyRatePoint[];
  }

  /**
   * Reads the newest stored rate of every currency.
   *
   * @returns One row per currency that has any rate at all.
   */
  public async findLatest(): Promise<CurrencyLatestRate[]> {
    return await this.query(
      `SELECT DISTINCT ON (c.code)
         c.code AS code,
         cr."effectiveOn"::text AS "effectiveOn",
         cr.rate::float8 AS rate
       FROM currency_rate cr
       JOIN currency c ON c.id = cr."currencyId"
       ORDER BY c.code, cr."effectiveOn" DESC`,
    ) as CurrencyLatestRate[];
  }

  /**
   * Summarizes what is stored per currency, for the backfill's report.
   *
   * @returns One row per currency holding any rate.
   */
  public async coverage(): Promise<CurrencyRateCoverageRow[]> {
    return await this.query(
      `SELECT c.code AS code,
              count(*)::int AS days,
              MIN(cr."effectiveOn")::text AS "firstDay",
              MAX(cr."effectiveOn")::text AS "lastDay",
              (MAX(cr."effectiveOn") - MIN(cr."effectiveOn") + 1)::int AS span
       FROM currency_rate cr
       JOIN currency c ON c.id = cr."currencyId"
       GROUP BY c.code
       ORDER BY c.code`,
    ) as CurrencyRateCoverageRow[];
  }

  /**
   * Finds the runs of days a currency's stored series is missing.
   *
   * Nothing should ever be found: the source publishes every calendar day, and
   * the handful its own first years omit are carried forward on ingest. A gap
   * therefore means the stored copy lost days, which is worth failing a
   * backfill over rather than discovering months later when a purchase lands
   * on one.
   *
   * Only the span between a currency's own first and last day is examined, so
   * currencies starting in different years (USD in 1996, EUR in 1999) are not
   * mistaken for holes.
   *
   * @returns One row per gap, by currency and then by day.
   */
  public async findGaps(): Promise<CurrencyRateGap[]> {
    return await this.query(
      `WITH d AS (
         SELECT c.code AS code,
                cr."effectiveOn" AS day,
                LEAD(cr."effectiveOn") OVER (
                  PARTITION BY c.code ORDER BY cr."effectiveOn"
                ) AS next
         FROM currency_rate cr
         JOIN currency c ON c.id = cr."currencyId"
       )
       SELECT code,
              day::text AS after,
              next::text AS before,
              (next - day - 1)::int AS missing
       FROM d
       WHERE next IS NOT NULL AND next - day > 1
       ORDER BY code, day`,
    ) as CurrencyRateGap[];
  }

  /**
   * Writes one chunk of rates in a single statement.
   *
   * @param chunk - Rows to write.
   */
  private async upsertChunk(chunk: CurrencyRateRow[]): Promise<void> {
    const values = chunk
      .map((_, index) => {
        const base = index * 3;

        return `($${base + 1}::uuid, $${base + 2}, $${base + 3}::date)`;
      })
      .join(', ');

    const params = chunk.flatMap(
      (row) => [row.currencyId, row.rate, row.effectiveOn],
    );

    await this.query(
      `INSERT INTO currency_rate ("currencyId", rate, "effectiveOn")
       VALUES ${values}
       ON CONFLICT ("currencyId", "effectiveOn") DO UPDATE SET
         rate = EXCLUDED.rate,
         "updatedAt" = now()`,
      params,
    );
  }

  /**
   * Resolves one chunk of pairs.
   *
   * @param chunk - The pairs to resolve.
   * @returns One probe per pair.
   */
  private async probeChunk(
    chunk: { code: string; day: string }[],
  ): Promise<CurrencyRateProbe[]> {
    const values = chunk
      .map((_, index) => {
        const base = index * 2;

        return `($${base + 1}::character varying, $${base + 2}::date)`;
      })
      .join(', ');

    const params = chunk.flatMap((pair) => [pair.code, pair.day]);

    return await this.query(
      PROBE_SQL.replace('%VALUES%', values),
      params,
    ) as CurrencyRateProbe[];
  }

  /**
   * Collapses rows that name the same currency and day, keeping the last
   * one — an `ON CONFLICT` statement rejects a batch that touches the same key
   * twice, so this has to happen before the write rather than in it.
   *
   * @param rates - The incoming rows.
   * @returns One row per `(currencyId, effectiveOn)`.
   */
  private dedupe(rates: CurrencyRateRow[]): CurrencyRateRow[] {
    const byKey = new Map<string, CurrencyRateRow>();

    rates.forEach((rate) => {
      byKey.set(`${rate.currencyId}|${rate.effectiveOn}`, rate);
    });

    return [...byKey.values()];
  }

  /**
   * Collapses duplicate lookup pairs and normalizes their codes.
   *
   * @param pairs - The incoming pairs.
   * @returns One pair per distinct `(code, day)`.
   */
  private dedupePairs(
    pairs: { code: string; day: string }[],
  ): { code: string; day: string }[] {
    const byKey = new Map<string, { code: string; day: string }>();

    pairs.forEach((pair) => {
      const code = pair.code.trim().toUpperCase();

      byKey.set(`${code}|${pair.day}`, { code, day: pair.day });
    });

    return [...byKey.values()];
  }
}
