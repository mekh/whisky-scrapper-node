import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  DashboardBreakdownRow,
  DashboardCaptureBounds,
  DashboardDailyCountryRow,
  DashboardDailyRow,
  DashboardDailyStoreRow,
  DashboardMover,
  DashboardStoreCoverage,
  ID,
  PriceHistoryPoint,
  PriceSnapshotUpsertInput,
} from '~types';

import { PriceSnapshotEntity } from './price-snapshot.entity';

/**
 * Shared aggregate select over one group of snapshots. Counts key on the
 * snapshot rows — one row = one listing that ended that day in stock, which
 * is what every caller's `AND ps."inStock"` predicate guarantees; distinct
 * counts climb to the bottling; percentiles share one sort, so asking for
 * three costs barely more than one. Casts follow the house convention —
 * `::int` because node-postgres returns bigint as a string, `::float8` for
 * numerics.
 */
const DAILY_SELECT = `
  COUNT(*)::int AS "inStockListings",
  COUNT(DISTINCT sp."productId")::int AS "distinctProducts",
  COUNT(DISTINCT p."brandId")::int AS "distinctBrands",
  COUNT(DISTINCT sp."storeId")::int AS "activeStores",
  percentile_cont(0.25) WITHIN GROUP (ORDER BY ps.price)::float8
    AS "p25Price",
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
    AS "medianPrice",
  percentile_cont(0.75) WITHIN GROUP (ORDER BY ps.price)::float8
    AS "p75Price",
  COUNT(*) FILTER (WHERE ps.promo)::int AS "promoListings"`;

/**
 * Shared join chain from a snapshot up to its listing, bottling and store.
 * New dashboard SQL keys on `capturedOn` (the column with the one-row-per-day
 * unique index), not on the `createdAt::date` the legacy report queries use.
 */
const DAILY_FROM = `
  FROM price_snapshot ps
  JOIN store_product sp ON sp.id = ps."storeProductId"
  JOIN product p ON p.id = sp."productId"
  JOIN store st ON st.id = sp."storeId"`;

/**
 * Range + optional store-slug scope shared by every dashboard aggregate.
 *
 * `ps."inStock"` is part of the scope, not an extra filter: the dashboard
 * describes what was *available* on a day, and a snapshot row no longer
 * implies availability. A store whose listing carries its sold-out items
 * (silpo) writes a priced row for each of them, and an offer that goes out of
 * stock between two runs of the same day keeps the row the earlier run wrote —
 * counting rows instead of in-stock rows made that day a high-water mark.
 */
const DAILY_WHERE = `
  WHERE ps."capturedOn" BETWEEN $1::date AND $2::date
    AND ps."inStock"
    AND ($3::text[] IS NULL OR st.slug = ANY($3))`;

/**
 * The single-day counterpart of {@link DAILY_WHERE}: one capture day ($1) and
 * the optional store scope ($2), shared by the breakdown queries and their
 * denominators so the day's slices and its totals cannot disagree on what
 * they count.
 */
const DAY_WHERE = `
  WHERE ps."capturedOn" = $1::date
    AND ps."inStock"
    AND ($2::text[] IS NULL OR st.slug = ANY($2))`;

@TypeormRepository(PriceSnapshotEntity)
export class PriceSnapshotRepository
  extends BaseRepository<PriceSnapshotEntity> {
  /**
   * Writes one store offer's snapshot for a given capture day: inserts it, or
   * overwrites the existing row for that `(storeProductId, capturedOn)` so
   * there is always exactly one row per offer per day (last write wins). Atomic
   * via the unique index — safe against concurrent same-day syncs.
   *
   * @param storeProductId - Store offer the snapshot belongs to.
   * @param capturedOn - Capture day (`YYYY-MM-DD`).
   * @param data - The snapshot's price fields.
   * @returns Resolves once the row is written.
   */
  public async upsertForDate(
    storeProductId: ID,
    capturedOn: string,
    data: PriceSnapshotUpsertInput,
  ): Promise<void> {
    await this.query(
      `INSERT INTO price_snapshot
         ("storeProductId", "capturedOn", price, "oldPrice", currency,
          "inStock", promo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("storeProductId", "capturedOn") DO UPDATE SET
         price = EXCLUDED.price,
         "oldPrice" = EXCLUDED."oldPrice",
         currency = EXCLUDED.currency,
         "inStock" = EXCLUDED."inStock",
         promo = EXCLUDED.promo,
         "updatedAt" = now()`,
      [
        storeProductId,
        capturedOn,
        data.price,
        data.oldPrice,
        data.currency,
        data.inStock,
        data.promo,
      ],
    );
  }

  /**
   * Flags a store's snapshots for one capture day out of stock wherever the
   * offer itself now is — the write that keeps a day's rows agreeing with the
   * availability the run ended on.
   *
   * It exists because a snapshot is written when an offer is *seen* in stock,
   * while the sweep decides availability only after the whole listing has been
   * walked, and a day can hold several runs. Without this, the first run of a
   * day owned its rows: an offer sold out by the afternoon still counted as
   * available for that day, and no later run could correct it (an out-of-stock
   * offer is never upserted, so nothing rewrites the row). The opposite
   * direction needs no statement — an offer seen in stock again has its row
   * upserted with `inStock = true`.
   *
   * Call it inside the persist transaction, after the sweep.
   *
   * @param storeId - The store whose day is being reconciled.
   * @param capturedOn - Capture day (`YYYY-MM-DD`).
   * @returns How many snapshot rows were flagged.
   */
  public async markOutOfStockForDay(
    storeId: ID,
    capturedOn: string,
  ): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(PriceSnapshotEntity)
      .set({ inStock: false })
      .where('"capturedOn" = :capturedOn', { capturedOn })
      .andWhere('"inStock"')
      .andWhere(
        '"storeProductId" IN (SELECT sp.id FROM store_product sp'
          + ' WHERE sp."storeId" = :storeId AND NOT sp."inStock")',
        { storeId },
      )
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Returns the most recent snapshot capture date across all offers.
   *
   * @returns The latest date (`YYYY-MM-DD`), or null when there are none.
   */
  public async latestDate(): Promise<string | null> {
    const rows = await this.query(
      'SELECT MAX("createdAt"::date)::text AS d FROM price_snapshot',
    ) as { d: string | null }[];

    return rows[0]?.d ?? null;
  }

  /**
   * Computes the min and max price per store offer over snapshots on/after a
   * cutoff date.
   *
   * @param cutoff - Inclusive lower bound date (`YYYY-MM-DD`).
   * @returns Map from store-offer id to its `{ min, max }` over the window.
   */
  public async priceExtremes(
    cutoff: string,
  ): Promise<Map<ID, { min: number; max: number }>> {
    const rows = await this.query(
      `SELECT "storeProductId",
              MIN(price)::float8 AS min, MAX(price)::float8 AS max
       FROM price_snapshot
       WHERE "createdAt"::date >= $1
       GROUP BY "storeProductId"`,
      [cutoff],
    ) as { storeProductId: ID; min: number; max: number }[];

    return new Map(rows.map((row) => [row.storeProductId, {
      min: row.min,
      max: row.max,
    }]));
  }

  /**
   * For every store offer, the date since which its price has not been higher
   * than its current (latest) price — i.e. when the current price level took
   * hold. It is the capture date of the first snapshot after the most recent
   * one priced above the current price; when the price was never higher, the
   * offer's very first snapshot. Ages the `drops` report's current discount.
   *
   * @returns Map from store-offer id to that date (`YYYY-MM-DD`).
   */
  public async currentPriceSince(): Promise<Map<ID, string>> {
    const rows = await this.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("storeProductId")
                "storeProductId", price AS "currentPrice"
         FROM price_snapshot
         ORDER BY "storeProductId", "createdAt" DESC
       ),
       last_higher AS (
         SELECT s."storeProductId", MAX(s."createdAt") AS "higherAt"
         FROM price_snapshot s
         JOIN latest l ON l."storeProductId" = s."storeProductId"
         WHERE s.price > l."currentPrice"
         GROUP BY s."storeProductId"
       )
       SELECT s."storeProductId", MIN(s."createdAt")::date::text AS since
       FROM price_snapshot s
       LEFT JOIN last_higher h ON h."storeProductId" = s."storeProductId"
       WHERE h."higherAt" IS NULL OR s."createdAt" > h."higherAt"
       GROUP BY s."storeProductId"`,
    ) as { storeProductId: ID; since: string }[];

    return new Map(rows.map((row) => [row.storeProductId, row.since]));
  }

  /**
   * Loads one store offer's price history, oldest point first. The series is
   * deliberately per offer: a price history belongs to the store that set it,
   * and merging several stores' into one line would describe nothing real.
   *
   * @param storeProductId - Store-offer id.
   * @param limit - Maximum number of most-recent points to return.
   * @returns Chronological price points.
   */
  public async priceSeries(
    storeProductId: ID,
    limit: number,
  ): Promise<PriceHistoryPoint[]> {
    const rows = await this.query(
      `SELECT "createdAt"::date::text AS date, price::float8 AS price
       FROM price_snapshot
       WHERE "storeProductId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [storeProductId, limit],
    ) as PriceHistoryPoint[];

    return rows.reverse();
  }

  /**
   * The snapshot table's overall coverage: earliest and latest capture day
   * plus how many distinct days exist. The dashboard's data floor.
   *
   * @returns The capture bounds; both dates null on an empty table.
   */
  public async captureBounds(): Promise<DashboardCaptureBounds> {
    const rows = await this.query(
      `SELECT MIN("capturedOn")::text AS floor,
              MAX("capturedOn")::text AS latest,
              COUNT(DISTINCT "capturedOn")::int AS "dayCount"
       FROM price_snapshot`,
    ) as DashboardCaptureBounds[];

    return rows[0] ?? { floor: null, latest: null, dayCount: 0 };
  }

  /**
   * Per-store snapshot coverage and listing counts, one row per store (also
   * stores with no data yet). Feeds the dashboard's store legend and its
   * "store added" chart annotations.
   *
   * @returns One row per store, ordered by store name.
   */
  public async coverage(): Promise<DashboardStoreCoverage[]> {
    return this.query(
      `SELECT st.slug, st.name, st.color, st.active,
              cov."firstDate", cov."lastDate",
              COALESCE(lst.listings, 0) AS listings,
              COALESCE(lst."inStockListings", 0) AS "inStockListings"
       FROM store st
       LEFT JOIN (
         SELECT sp."storeId",
                COUNT(*)::int AS listings,
                COUNT(*) FILTER (WHERE sp."inStock")::int
                  AS "inStockListings"
         FROM store_product sp
         GROUP BY 1
       ) lst ON lst."storeId" = st.id
       LEFT JOIN (
         SELECT sp."storeId",
                MIN(ps."capturedOn")::text AS "firstDate",
                MAX(ps."capturedOn")::text AS "lastDate"
         FROM price_snapshot ps
         JOIN store_product sp ON sp.id = ps."storeProductId"
         GROUP BY 1
       ) cov ON cov."storeId" = st.id
       ORDER BY st.name`,
    ) as Promise<DashboardStoreCoverage[]>;
  }

  /**
   * Daily snapshot aggregates over a range: one row per capture day that has
   * data (days without snapshots yield no row).
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per day with data, ascending by date.
   */
  public async dailyMetrics(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyRow[]> {
    return this.query(
      `SELECT ps."capturedOn"::text AS date,${DAILY_SELECT}
       ${DAILY_FROM}
       ${DAILY_WHERE}
       GROUP BY ps."capturedOn"
       ORDER BY ps."capturedOn"`,
      [from, to, stores],
    ) as Promise<DashboardDailyRow[]>;
  }

  /**
   * Daily snapshot aggregates partitioned by store. The `stores` scope and
   * the partitioning are orthogonal: the scope narrows what is counted, the
   * partitioning splits that same scope per store.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per (day, store) with data, ascending by date then
   *   store slug.
   */
  public async dailyMetricsByStore(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyStoreRow[]> {
    return this.query(
      `SELECT ps."capturedOn"::text AS date,
              st.slug AS "storeSlug",
              st.name AS "storeName",
              st.color AS "storeColor",${DAILY_SELECT}
       ${DAILY_FROM}
       ${DAILY_WHERE}
       GROUP BY ps."capturedOn", st.slug, st.name, st.color
       ORDER BY ps."capturedOn", st.slug`,
      [from, to, stores],
    ) as Promise<DashboardDailyStoreRow[]>;
  }

  /**
   * Daily snapshot aggregates partitioned by the bottling's country.
   * Products without a country fall under the `unknown` key.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per (day, country) with data, ascending by date then
   *   country code.
   */
  public async dailyMetricsByCountry(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyCountryRow[]> {
    return this.query(
      `SELECT ps."capturedOn"::text AS date,
              COALESCE(c.code, 'unknown') AS "countryCode",
              COALESCE(c."nameUa", 'unknown') AS "countryName",
              c.icon AS "countryIcon",${DAILY_SELECT}
       ${DAILY_FROM}
       LEFT JOIN country c ON c.id = p."countryId"
       ${DAILY_WHERE}
       GROUP BY ps."capturedOn", c.code, c."nameUa", c.icon
       ORDER BY ps."capturedOn", COALESCE(c.code, 'unknown')`,
      [from, to, stores],
    ) as Promise<DashboardDailyCountryRow[]>;
  }

  /**
   * Snapshot aggregates for just the first and last day with data inside a
   * range — the two rows a KPI summary needs. Measured ~7x cheaper than
   * computing the full series and reading its ends.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns Zero, one (single data day) or two rows, ascending by date.
   */
  public async boundaryMetrics(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyRow[]> {
    return this.query(
      `WITH bounds AS (
         SELECT MIN(ps."capturedOn") AS d0, MAX(ps."capturedOn") AS d1
         ${DAILY_FROM}
         ${DAILY_WHERE}
       )
       SELECT ps."capturedOn"::text AS date,${DAILY_SELECT}
       ${DAILY_FROM}
       WHERE ps."capturedOn" IN (
           SELECT d0 FROM bounds UNION SELECT d1 FROM bounds
         )
         AND ps."inStock"
         AND ($3::text[] IS NULL OR st.slug = ANY($3))
       GROUP BY ps."capturedOn"
       ORDER BY ps."capturedOn"`,
      [from, to, stores],
    ) as Promise<DashboardDailyRow[]>;
  }

  /**
   * Listing and distinct-bottling totals for one capture day — the breakdown
   * denominators. Bucket sums cannot stand in: flavor buckets overlap, and a
   * bottling carried by several stores counts once here but once per bucket
   * in a store breakdown.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns The day's totals; zeros when the day has no data.
   */
  public async totalsForDate(
    date: string,
    stores: string[] | null,
  ): Promise<{ listings: number; products: number }> {
    const rows = await this.query(
      `SELECT COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products
       ${DAILY_FROM}
       ${DAY_WHERE}`,
      [date, stores],
    ) as { listings: number; products: number }[];

    return rows[0] ?? { listings: 0, products: 0 };
  }

  /**
   * One capture day's in-stock assortment sliced by whisky type. Typeless
   * bottlings fall under the `unknown` key.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per type, largest listing count first.
   */
  public async breakdownByType(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.query(
      `SELECT COALESCE(t.name, 'unknown') AS key,
              COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
                AS "medianPrice"
       ${DAILY_FROM}
       LEFT JOIN type t ON t.id = p."typeId"
       ${DAY_WHERE}
       GROUP BY 1
       ORDER BY 2 DESC`,
      [date, stores],
    ) as Promise<DashboardBreakdownRow[]>;
  }

  /**
   * One capture day's in-stock assortment sliced by the bottling's country.
   * Countryless bottlings fall under the `unknown` key.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per country code, largest listing count first.
   */
  public async breakdownByCountry(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.query(
      `SELECT COALESCE(c.code, 'unknown') AS key,
              COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
                AS "medianPrice"
       ${DAILY_FROM}
       LEFT JOIN country c ON c.id = p."countryId"
       ${DAY_WHERE}
       GROUP BY 1
       ORDER BY 2 DESC`,
      [date, stores],
    ) as Promise<DashboardBreakdownRow[]>;
  }

  /**
   * One capture day's in-stock assortment sliced by store.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per store slug, largest listing count first.
   */
  public async breakdownByStore(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.query(
      `SELECT st.slug AS key,
              COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
                AS "medianPrice"
       ${DAILY_FROM}
       ${DAY_WHERE}
       GROUP BY 1
       ORDER BY 2 DESC`,
      [date, stores],
    ) as Promise<DashboardBreakdownRow[]>;
  }

  /**
   * One capture day's in-stock assortment sliced by flavor tag. Buckets
   * overlap — a bottling carries several tags — so listing counts must not
   * be summed into a total.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per flavor, largest listing count first.
   */
  public async breakdownByFlavor(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.query(
      `SELECT f.name AS key,
              COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
                AS "medianPrice"
       ${DAILY_FROM}
       JOIN product_flavor pf ON pf."productId" = sp."productId"
       JOIN flavor f ON f.id = pf."flavorId"
       ${DAY_WHERE}
       GROUP BY 1
       ORDER BY 2 DESC`,
      [date, stores],
    ) as Promise<DashboardBreakdownRow[]>;
  }

  /**
   * One capture day's in-stock assortment sliced into price buckets via
   * `width_bucket`. The key is the bucket ordinal as text: `0` is everything
   * below the first boundary, the last ordinal is open-ended above the final
   * one. The caller maps ordinals to their price bounds.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @param boundaries - Ascending inner bucket boundaries (UAH).
   * @returns One row per non-empty bucket, ascending by ordinal.
   */
  public async breakdownByPriceBucket(
    date: string,
    stores: string[] | null,
    boundaries: number[],
  ): Promise<DashboardBreakdownRow[]> {
    return this.query(
      `SELECT width_bucket(ps.price, $3::numeric[])::text AS key,
              COUNT(*)::int AS listings,
              COUNT(DISTINCT sp."productId")::int AS products,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.price)::float8
                AS "medianPrice"
       ${DAILY_FROM}
       ${DAY_WHERE}
       GROUP BY width_bucket(ps.price, $3::numeric[])
       ORDER BY width_bucket(ps.price, $3::numeric[])`,
      [date, stores, boundaries],
    ) as Promise<DashboardBreakdownRow[]>;
  }

  /**
   * Price movers over a range: for every listing with snapshots on at least
   * two distinct days inside it, the first and last snapshot are compared
   * and the biggest changes returned. Both edge lookups ride the
   * `(storeProductId, capturedOn)` unique index. The edges float inside the
   * range — a listing that appeared mid-range or went out of stock early is
   * compared over the days it actually had. `f.price > 0` guards the
   * `1.00 грн` placeholder some stores use on unavailable items.
   *
   * Only in-stock snapshots bound the comparison, so a price a store kept
   * quoting on a sold-out listing cannot become a mover. The predicate sits in
   * the `bounds` CTE alone and still holds for the edge joins: one row exists
   * per `(storeProductId, capturedOn)`, so the row each join finds *is* the
   * row that produced the bound.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @param limit - Rows to return.
   * @param minPrice - Minimum starting price, or null for no floor.
   * @param direction - `asc` returns the biggest drops (most negative
   *   change first), `desc` the biggest rises.
   * @returns The top movers for the direction.
   */
  public async priceEdges(
    from: string,
    to: string,
    stores: string[] | null,
    limit: number,
    minPrice: number | null,
    direction: 'asc' | 'desc',
  ): Promise<DashboardMover[]> {
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    return this.query(
      `WITH bounds AS (
         SELECT ps."storeProductId" AS spid,
                MIN(ps."capturedOn") AS d0,
                MAX(ps."capturedOn") AS d1
         FROM price_snapshot ps
         WHERE ps."capturedOn" BETWEEN $1::date AND $2::date
           AND ps."inStock"
         GROUP BY 1
       ),
       edges AS (
         SELECT b.spid, b.d0, b.d1,
                f.price AS p0, l.price AS p1, l.currency
         FROM bounds b
         JOIN price_snapshot f
           ON f."storeProductId" = b.spid AND f."capturedOn" = b.d0
         JOIN price_snapshot l
           ON l."storeProductId" = b.spid AND l."capturedOn" = b.d1
         WHERE b.d0 < b.d1 AND f.price > 0
       )
       SELECT e.spid AS "storeProductId", sp."productId",
              p.name, sp."nameOrig",
              st.slug AS "storeSlug", st.name AS "storeName",
              e.d0::text AS "firstDate", e.d1::text AS "lastDate",
              e.p0::float8 AS "firstPrice", e.p1::float8 AS "lastPrice",
              (e.p1 - e.p0)::float8 AS "changeAbs",
              ((e.p1 - e.p0) / e.p0 * 100)::float8 AS "changePct",
              e.currency
       FROM edges e
       JOIN store_product sp ON sp.id = e.spid
       JOIN product p ON p.id = sp."productId"
       JOIN store st ON st.id = sp."storeId"
       WHERE e.p1 <> e.p0
         AND ($3::text[] IS NULL OR st.slug = ANY($3))
         AND ($4::float8 IS NULL OR e.p0 >= $4)
       ORDER BY ((e.p1 - e.p0) / e.p0) ${order}
       LIMIT $5`,
      [from, to, stores, minPrice, limit],
    ) as Promise<DashboardMover[]>;
  }
}
