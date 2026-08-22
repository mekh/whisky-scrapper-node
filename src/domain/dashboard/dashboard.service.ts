import { Injectable } from '@nestjs/common';

import {
  DASHBOARD_AUTO_WEEK_DAYS,
  DASHBOARD_MAX_RANGE_DAYS,
  DASHBOARD_MOVERS_LIMIT,
  DASHBOARD_PRICE_BUCKETS,
} from '~constants';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreStoreProductService } from '~core/store-product';
import { CoreSyncLogService } from '~core/sync-log';
import { DashboardBreakdownBy, DashboardGranularity } from '~enums';
import { BadRequestError } from '~errors';
import {
  DashboardBreakdown,
  DashboardBreakdownBucket,
  DashboardBreakdownQuery,
  DashboardBreakdownRow,
  DashboardDailyRow,
  DashboardLifecycleGroupRow,
  DashboardMeta,
  DashboardMetric,
  DashboardMovers,
  DashboardMoversQuery,
  DashboardRangeQuery,
  DashboardSeries,
  DashboardSeriesPoint,
  DashboardSeriesQuery,
  DashboardSummary,
  DashboardSyncActivity,
} from '~types';
import { DashboardMetricsUtils } from '~utils';

/**
 * A validated, snapshot-clamped date range. `empty` marks a request whose
 * range holds no data at all (an empty database, or a range entirely before
 * the data floor) — endpoints answer it with empty payloads, echoing the
 * requested range untouched.
 */
interface ResolvedRange {
  /**
   * Resolved inclusive range start (`YYYY-MM-DD`).
   */
  from: string;

  /**
   * Resolved inclusive range end (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * Store-slug scope, or null for all stores.
   */
  stores: string[] | null;

  /**
   * True when the range holds no snapshot data.
   */
  empty: boolean;
}

@Injectable()
export class DashboardService {
  public constructor(
    private readonly snapshots: CorePriceSnapshotService,
    private readonly offers: CoreStoreProductService,
    private readonly syncLogs: CoreSyncLogService,
  ) {}

  /**
   * The dashboard's static context: overall capture bounds plus per-store
   * coverage. Parameterless, so the browser cache serves nearly every load.
   *
   * @returns The capture bounds and store coverage.
   */
  public async meta(): Promise<DashboardMeta> {
    const [bounds, stores] = await Promise.all([
      this.snapshots.captureBounds(),
      this.snapshots.coverage(),
    ]);

    return {
      dataFloorDate: bounds.floor,
      latestDate: bounds.latest,
      dayCount: bounds.dayCount,
      stores,
    };
  }

  /**
   * KPI summary over a range: every metric as its boundary pair (first and
   * last day with data) plus the deltas between them. Only the two boundary
   * days are aggregated — measured ~7x cheaper than the full series.
   *
   * @param query - The validated range query.
   * @returns The summary; all metrics null when the range holds no data.
   * @throws {BadRequestError} On an inverted or oversized range.
   */
  public async summary(query: DashboardRangeQuery): Promise<DashboardSummary> {
    const range = await this.resolveRange(query);

    if (range.empty) {
      return this.emptySummary(range);
    }

    const boundary = await this.snapshots.boundaryMetrics(
      range.from,
      range.to,
      range.stores,
    );

    const baseRow = boundary[0] ?? null;
    const lastRow = boundary[boundary.length - 1] ?? null;

    if (!baseRow || !lastRow) {
      return this.emptySummary(range);
    }

    const [lifeBase, lifeLast] = await Promise.all([
      this.offers.lifecycleByDay(baseRow.date, baseRow.date, range.stores),
      this.offers.lifecycleByDay(lastRow.date, lastRow.date, range.stores),
    ]);

    const trackedBase = lifeBase[0]?.trackedListings ?? 0;
    const trackedLast = lifeLast[0]?.trackedListings ?? 0;

    return {
      from: range.from,
      to: range.to,
      baselineDate: baseRow.date,
      latestDate: lastRow.date,
      inStockListings: DashboardMetricsUtils.metric(
        lastRow.inStockListings,
        baseRow.inStockListings,
      ),
      trackedListings: DashboardMetricsUtils.metric(
        trackedLast,
        trackedBase,
      ),
      oosListings: DashboardMetricsUtils.metric(
        DashboardMetricsUtils.deriveOos(trackedLast, lastRow.inStockListings),
        DashboardMetricsUtils.deriveOos(trackedBase, baseRow.inStockListings),
      ),
      distinctProducts: DashboardMetricsUtils.metric(
        lastRow.distinctProducts,
        baseRow.distinctProducts,
      ),
      distinctBrands: DashboardMetricsUtils.metric(
        lastRow.distinctBrands,
        baseRow.distinctBrands,
      ),
      medianPrice: DashboardMetricsUtils.metric(
        lastRow.medianPrice,
        baseRow.medianPrice,
      ),
      promoShare: DashboardMetricsUtils.metric(
        this.promoShare(lastRow),
        this.promoShare(baseRow),
      ),
      activeStores: DashboardMetricsUtils.metric(
        lastRow.activeStores,
        baseRow.activeStores,
      ),
    };
  }

  /**
   * Per-day metric series over a range: the total, plus optional per-store
   * and per-country partitions. Snapshot and lifecycle aggregates are merged
   * in `DashboardMetricsUtils`; the derived out-of-stock series comes from
   * that merge. Long unpinned ranges are downsampled to weekly buckets.
   *
   * @param query - The validated series query.
   * @returns The series; empty arrays when the range holds no data.
   * @throws {BadRequestError} On an inverted or oversized range.
   */
  public async series(query: DashboardSeriesQuery): Promise<DashboardSeries> {
    const range = await this.resolveRange(query);
    const granularity = this.resolveGranularity(query.granularity, range);

    if (range.empty) {
      return {
        from: range.from,
        to: range.to,
        granularity,
        total: [],
        byStore: [],
        byCountry: [],
      };
    }

    const [daily, lifecycle] = await Promise.all([
      this.snapshots.dailyMetrics(range.from, range.to, range.stores),
      this.offers.lifecycleByDay(range.from, range.to, range.stores),
    ]);

    return {
      from: range.from,
      to: range.to,
      granularity,
      total: this.bucketize(
        DashboardMetricsUtils.mergePoints(daily, lifecycle),
        granularity,
      ),
      byStore: query.byStore
        ? await this.buildStoreSeries(range, granularity)
        : [],
      byCountry: query.byCountry
        ? await this.buildCountrySeries(range, granularity)
        : [],
    };
  }

  /**
   * One capture day's in-stock assortment sliced by a dimension. An absent
   * or out-of-bounds date resolves to the nearest day with data and is
   * echoed, so the client always knows which day it is looking at.
   *
   * @param query - The validated breakdown query.
   * @returns The breakdown; empty buckets when there is no data at all.
   */
  public async breakdown(
    query: DashboardBreakdownQuery,
  ): Promise<DashboardBreakdown> {
    const stores = this.storesScope(query.stores);
    const bounds = await this.snapshots.captureBounds();
    const overlapping = query.by === DashboardBreakdownBy.FLAVOR;

    if (!bounds.floor || !bounds.latest) {
      return {
        by: query.by,
        date: query.date ?? this.today(),
        overlapping,
        totalListings: 0,
        totalProducts: 0,
        buckets: [],
      };
    }

    const date = this.clampDate(
      query.date ?? bounds.latest,
      bounds.floor,
      bounds.latest,
    );

    const [rows, totals] = await Promise.all([
      this.breakdownRows(query.by, date, stores),
      this.snapshots.totalsForDate(date, stores),
    ]);

    return {
      by: query.by,
      date,
      overlapping,
      totalListings: totals.listings,
      totalProducts: totals.products,
      buckets: rows.map((row) => this.toBucket(query.by, row)),
    };
  }

  /**
   * The biggest price drops and rises over a range, compared between each
   * listing's first and last snapshot inside it.
   *
   * @param query - The validated movers query.
   * @returns Both directions; empty when the range holds no data.
   * @throws {BadRequestError} On an inverted or oversized range.
   */
  public async movers(query: DashboardMoversQuery): Promise<DashboardMovers> {
    const range = await this.resolveRange(query);

    if (range.empty) {
      return { from: range.from, to: range.to, drops: [], rises: [] };
    }

    const limit = query.limit ?? DASHBOARD_MOVERS_LIMIT;
    const minPrice = query.minPrice ?? null;

    const [drops, rises] = await Promise.all([
      this.snapshots.priceEdges(
        range.from,
        range.to,
        range.stores,
        limit,
        minPrice,
        'asc',
      ),
      this.snapshots.priceEdges(
        range.from,
        range.to,
        range.stores,
        limit,
        minPrice,
        'desc',
      ),
    ]);

    return {
      from: range.from,
      to: range.to,
      drops: drops.filter((mover) => mover.changePct < 0),
      rises: rises.filter((mover) => mover.changePct > 0),
    };
  }

  /**
   * Sync-run activity per day over a range. The range is validated but not
   * clamped to snapshot bounds — the sync log has its own history.
   *
   * @param query - The validated range query.
   * @returns One entry per day that had runs.
   * @throws {BadRequestError} On an inverted or oversized range.
   */
  public async syncActivity(
    query: DashboardRangeQuery,
  ): Promise<DashboardSyncActivity> {
    this.validateRange(query);

    const days = await this.syncLogs.activityByDay(
      query.from,
      query.to,
      this.storesScope(query.stores),
    );

    return { from: query.from, to: query.to, days };
  }

  /**
   * Builds the per-store series partition: grouped snapshot and lifecycle
   * rows merged per slug, labeled from the store coverage.
   *
   * @param range - The resolved range.
   * @param granularity - Bucketing to apply to every partition.
   * @returns One series per store, ascending by slug.
   */
  private async buildStoreSeries(
    range: ResolvedRange,
    granularity: DashboardGranularity,
  ): Promise<DashboardSeries['byStore']> {
    const [dailyRows, lifeRows, coverage] = await Promise.all([
      this.snapshots.dailyMetricsByStore(range.from, range.to, range.stores),
      this.offers.lifecycleByDayGrouped(
        range.from,
        range.to,
        range.stores,
        'store',
      ),
      this.snapshots.coverage(),
    ]);

    const labels = new Map(coverage.map((store) => [store.slug, store]));

    return this.mergeGroups(dailyRows, lifeRows, (row) => row.storeSlug)
      .map(({ key, points }) => ({
        storeSlug: key,
        name: labels.get(key)?.name ?? key,
        color: labels.get(key)?.color ?? null,
        points: this.bucketize(points, granularity),
      }));
  }

  /**
   * Builds the per-country series partition: grouped snapshot and lifecycle
   * rows merged per country code, labeled from the snapshot rows themselves.
   *
   * @param range - The resolved range.
   * @param granularity - Bucketing to apply to every partition.
   * @returns One series per country code, ascending by code.
   */
  private async buildCountrySeries(
    range: ResolvedRange,
    granularity: DashboardGranularity,
  ): Promise<DashboardSeries['byCountry']> {
    const [dailyRows, lifeRows] = await Promise.all([
      this.snapshots.dailyMetricsByCountry(
        range.from,
        range.to,
        range.stores,
      ),
      this.offers.lifecycleByDayGrouped(
        range.from,
        range.to,
        range.stores,
        'country',
      ),
    ]);

    const labels = new Map(dailyRows.map((row) => [row.countryCode, {
      nameUa: row.countryName,
      icon: row.countryIcon,
    }]));

    return this.mergeGroups(dailyRows, lifeRows, (row) => row.countryCode)
      .map(({ key, points }) => ({
        countryCode: key,
        nameUa: labels.get(key)?.nameUa ?? key,
        icon: labels.get(key)?.icon ?? null,
        points: this.bucketize(points, granularity),
      }));
  }

  /**
   * Merges grouped snapshot rows with grouped lifecycle rows into per-key
   * point series, over the union of both sides' keys.
   *
   * @param dailyRows - Snapshot aggregates carrying a partition key.
   * @param lifeRows - Lifecycle aggregates carrying a partition key.
   * @param keyOf - Reads the partition key off a snapshot row.
   * @returns One entry per key, ascending by key.
   */
  private mergeGroups<T extends DashboardDailyRow>(
    dailyRows: T[],
    lifeRows: DashboardLifecycleGroupRow[],
    keyOf: (row: T) => string,
  ): { key: string; points: DashboardSeriesPoint[] }[] {
    const dailyBy = new Map<string, T[]>();

    dailyRows.forEach((row) => {
      const key = keyOf(row);
      const bucket = dailyBy.get(key) ?? [];

      bucket.push(row);
      dailyBy.set(key, bucket);
    });

    const lifeBy = new Map<string, DashboardLifecycleGroupRow[]>();

    lifeRows.forEach((row) => {
      const bucket = lifeBy.get(row.key) ?? [];

      bucket.push(row);
      lifeBy.set(row.key, bucket);
    });

    const keys = [...new Set([...dailyBy.keys(), ...lifeBy.keys()])].sort();

    return keys.map((key) => ({
      key,
      points: DashboardMetricsUtils.mergePoints(
        dailyBy.get(key) ?? [],
        lifeBy.get(key) ?? [],
      ),
    }));
  }

  /**
   * Applies the resolved granularity to a point series.
   *
   * @param points - Daily points, ascending by date.
   * @param granularity - Bucketing to apply.
   * @returns The points, weekly-downsampled when requested.
   */
  private bucketize(
    points: DashboardSeriesPoint[],
    granularity: DashboardGranularity,
  ): DashboardSeriesPoint[] {
    if (granularity === DashboardGranularity.WEEK) {
      return DashboardMetricsUtils.downsampleToWeeks(points);
    }

    return points;
  }

  /**
   * Runs the breakdown query for one dimension.
   *
   * @param by - The slicing dimension.
   * @param date - Resolved capture day.
   * @param stores - Store-slug scope, or null.
   * @returns The raw bucket rows.
   */
  private async breakdownRows(
    by: DashboardBreakdownBy,
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    switch (by) {
      case DashboardBreakdownBy.TYPE:
        return this.snapshots.breakdownByType(date, stores);
      case DashboardBreakdownBy.COUNTRY:
        return this.snapshots.breakdownByCountry(date, stores);
      case DashboardBreakdownBy.STORE:
        return this.snapshots.breakdownByStore(date, stores);
      case DashboardBreakdownBy.FLAVOR:
        return this.snapshots.breakdownByFlavor(date, stores);
      case DashboardBreakdownBy.PRICE_BUCKET:
        return this.snapshots.breakdownByPriceBucket(date, stores, [
          ...DASHBOARD_PRICE_BUCKETS,
        ]);
    }
  }

  /**
   * Converts a raw bucket row into the response bucket, attaching price
   * bounds for the price-bucket dimension.
   *
   * @param by - The slicing dimension.
   * @param row - The raw bucket row.
   * @returns The response bucket.
   */
  private toBucket(
    by: DashboardBreakdownBy,
    row: DashboardBreakdownRow,
  ): DashboardBreakdownBucket {
    if (by !== DashboardBreakdownBy.PRICE_BUCKET) {
      return { ...row, minPrice: null, maxPrice: null };
    }

    const ordinal = Number(row.key);

    return {
      ...row,
      minPrice: ordinal > 0
        ? DASHBOARD_PRICE_BUCKETS[ordinal - 1] ?? null
        : null,
      maxPrice: ordinal < DASHBOARD_PRICE_BUCKETS.length
        ? DASHBOARD_PRICE_BUCKETS[ordinal] ?? null
        : null,
    };
  }

  /**
   * Validates a range and clamps it to the days that actually have snapshot
   * data.
   *
   * @param query - The raw range query.
   * @returns The resolved range; `empty` when nothing overlaps the data.
   * @throws {BadRequestError} On an inverted or oversized range.
   */
  private async resolveRange(
    query: DashboardRangeQuery,
  ): Promise<ResolvedRange> {
    this.validateRange(query);

    const stores = this.storesScope(query.stores);
    const bounds = await this.snapshots.captureBounds();

    if (!bounds.floor || !bounds.latest) {
      return { from: query.from, to: query.to, stores, empty: true };
    }

    const from = query.from > bounds.floor ? query.from : bounds.floor;
    const to = query.to < bounds.latest ? query.to : bounds.latest;

    if (from > to) {
      return { from: query.from, to: query.to, stores, empty: true };
    }

    return { from, to, stores, empty: false };
  }

  /**
   * Rejects inverted and oversized ranges. ISO dates compare correctly as
   * strings, so no parsing is needed for the ordering check.
   *
   * @param query - The raw range query.
   * @throws {BadRequestError} When `from` is after `to` or the span exceeds
   *   `DASHBOARD_MAX_RANGE_DAYS`.
   */
  private validateRange(query: DashboardRangeQuery): void {
    if (query.from > query.to) {
      throw new BadRequestError('"from" must not be after "to"');
    }

    const span = DashboardMetricsUtils.spanDays(query.from, query.to);

    if (span > DASHBOARD_MAX_RANGE_DAYS) {
      throw new BadRequestError(
        `Range must not exceed ${DASHBOARD_MAX_RANGE_DAYS} days`,
      );
    }
  }

  /**
   * Picks the effective series granularity: an explicit request always wins;
   * otherwise long ranges downsample to weeks.
   *
   * @param explicit - The granularity the request pinned, if any.
   * @param range - The resolved range.
   * @returns The granularity to apply and echo.
   */
  private resolveGranularity(
    explicit: DashboardGranularity | undefined,
    range: ResolvedRange,
  ): DashboardGranularity {
    if (explicit) {
      return explicit;
    }

    if (range.empty) {
      return DashboardGranularity.DAY;
    }

    const span = DashboardMetricsUtils.spanDays(range.from, range.to);

    return span > DASHBOARD_AUTO_WEEK_DAYS
      ? DashboardGranularity.WEEK
      : DashboardGranularity.DAY;
  }

  /**
   * Normalizes the optional store filter: an absent or empty list means no
   * scoping.
   *
   * @param stores - Store slugs from the query, if any.
   * @returns The slugs, or null for all stores.
   */
  private storesScope(stores: string[] | undefined): string[] | null {
    return stores?.length ? stores : null;
  }

  /**
   * The promo share of one day's aggregate row.
   *
   * @param row - The day's snapshot aggregate.
   * @returns The 0..1 share, or null when nothing was in stock.
   */
  private promoShare(row: DashboardDailyRow): number | null {
    if (row.inStockListings <= 0) {
      return null;
    }

    return row.promoListings / row.inStockListings;
  }

  /**
   * Builds the all-null summary for a range without data.
   *
   * @param range - The resolved (empty) range.
   * @returns The summary with every metric null.
   */
  private emptySummary(range: ResolvedRange): DashboardSummary {
    const empty = (): DashboardMetric =>
      DashboardMetricsUtils.metric(null, null);

    return {
      from: range.from,
      to: range.to,
      baselineDate: null,
      latestDate: null,
      inStockListings: empty(),
      trackedListings: empty(),
      oosListings: empty(),
      distinctProducts: empty(),
      distinctBrands: empty(),
      medianPrice: empty(),
      promoShare: empty(),
      activeStores: empty(),
    };
  }

  /**
   * Clamps a day into inclusive bounds.
   *
   * @param date - The requested day.
   * @param floor - Earliest allowed day.
   * @param latest - Latest allowed day.
   * @returns The clamped day.
   */
  private clampDate(date: string, floor: string, latest: string): string {
    if (date < floor) {
      return floor;
    }

    if (date > latest) {
      return latest;
    }

    return date;
  }

  /**
   * Today as a UTC calendar day, for echoing a date on an empty database.
   *
   * @returns The current UTC day (`YYYY-MM-DD`).
   */
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
