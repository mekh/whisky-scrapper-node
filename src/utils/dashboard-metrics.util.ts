import {
  DashboardDailyRow,
  DashboardLifecycleRow,
  DashboardMetric,
  DashboardSeriesPoint,
} from '~types';

/**
 * Milliseconds in one calendar day, for date-string arithmetic.
 */
const DAY_MS = 86_400_000;

/**
 * Pure composition helpers behind the dashboard endpoints: merging the
 * snapshot-side and lifecycle-side daily rows, deriving the out-of-stock
 * series, weekly downsampling and KPI delta arithmetic. Kept out of SQL so
 * the business rules are unit-testable without a database.
 */
export class DashboardMetricsUtils {
  /**
   * Derives the out-of-stock count for one day.
   *
   * The formula is `max(0, tracked - inStock)` with
   * `tracked = COUNT(listings WHERE firstSeen <= day)`. Measured against
   * production data this lands exactly on `COUNT(listings WHERE NOT
   * inStock)` for the latest day (1,034 on 2026-08-21), i.e. it agrees with
   * what the store pages already report. The tempting alternative — also
   * requiring `lastSeen >= day` — collapses to 0 on the latest day, because
   * a listing that is out of stock today has its `lastSeen` in the past and
   * drops out of the "listed" set entirely (measured: 0 vs 1,034 on
   * 2026-08-21; 102 vs 437 on 2026-07-31). Two caveats: the clamp absorbs a
   * retention-boundary artifact (snapshots exist on the data-floor day for
   * listings whose `firstSeen` is the day after), and a silently delisted
   * SKU keeps counting — the schema cannot distinguish it from a temporary
   * stock-out.
   *
   * @param tracked - Listings known by the day (`firstSeen <= day`).
   * @param inStock - Listings with a price snapshot on the day.
   * @returns The derived out-of-stock listing count, never negative.
   */
  public static deriveOos(tracked: number, inStock: number): number {
    return Math.max(0, tracked - inStock);
  }

  /**
   * Merges the snapshot-side daily rows with the lifecycle-side rows into
   * the dashboard series points, deriving `oosListings` per day.
   *
   * The lifecycle side is dense (one row per calendar day in range), while
   * the snapshot side only has rows for days with data — a day present only
   * on the lifecycle side becomes a point with zero in-stock counts and
   * null prices rather than a hole, so the series' x-axis stays continuous.
   *
   * @param daily - Snapshot aggregates, one row per day with data.
   * @param lifecycle - Lifecycle aggregates, one row per calendar day.
   * @returns Points for the union of both sides' days, ascending by date.
   */
  public static mergePoints(
    daily: DashboardDailyRow[],
    lifecycle: DashboardLifecycleRow[],
  ): DashboardSeriesPoint[] {
    const dailyByDate = new Map(daily.map((row) => [row.date, row]));
    const lifecycleByDate = new Map(lifecycle.map((row) => [row.date, row]));

    const dates = [
      ...new Set([...dailyByDate.keys(), ...lifecycleByDate.keys()]),
    ].sort();

    return dates.map((date) => {
      const day = dailyByDate.get(date);
      const life = lifecycleByDate.get(date);
      const inStock = day?.inStockListings ?? 0;
      const tracked = life?.trackedListings ?? 0;

      return {
        date,
        inStockListings: inStock,
        trackedListings: tracked,
        oosListings: DashboardMetricsUtils.deriveOos(tracked, inStock),
        distinctProducts: day?.distinctProducts ?? 0,
        distinctBrands: day?.distinctBrands ?? 0,
        activeStores: day?.activeStores ?? 0,
        medianPrice: day?.medianPrice ?? null,
        p25Price: day?.p25Price ?? null,
        p75Price: day?.p75Price ?? null,
        promoListings: day?.promoListings ?? 0,
        newListings: life?.newListings ?? 0,
        departedListings: life?.departedListings ?? 0,
      };
    });
  }

  /**
   * Downsamples daily points into ISO weeks (Monday-started buckets).
   *
   * Level metrics (counts, prices — everything that describes a state) take
   * the value of the bucket's **last** day: a real observation, where a mean
   * of medians or a sum of levels would describe nothing. Flow metrics
   * (`newListings`, `departedListings` — events) are **summed** over the
   * bucket. The bucket is labeled with its Monday, even when the first data
   * day inside it is later.
   *
   * @param points - Daily points, ascending by date.
   * @returns One point per ISO week, ascending by bucket start.
   */
  public static downsampleToWeeks(
    points: DashboardSeriesPoint[],
  ): DashboardSeriesPoint[] {
    const buckets = new Map<string, DashboardSeriesPoint>();

    points.forEach((point) => {
      const week = DashboardMetricsUtils.weekStart(point.date);
      const bucket = buckets.get(week);

      if (!bucket) {
        buckets.set(week, { ...point, date: week });

        return;
      }

      buckets.set(week, {
        ...point,
        date: week,
        newListings: bucket.newListings + point.newListings,
        departedListings: bucket.departedListings + point.departedListings,
      });
    });

    return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Builds one KPI metric from its boundary values.
   *
   * @param latest - Value on the last day with data, or null.
   * @param baseline - Value on the first day with data, or null.
   * @returns The metric; `deltaPct` is null when the baseline is null or
   *   zero (a percentage of nothing is undefined, not infinity).
   */
  public static metric(
    latest: number | null,
    baseline: number | null,
  ): DashboardMetric {
    const delta = latest !== null && baseline !== null
      ? latest - baseline
      : null;

    const deltaPct = delta !== null && baseline
      ? (delta / baseline) * 100
      : null;

    return { latest, baseline, delta, deltaPct };
  }

  /**
   * Counts the calendar days a `from`..`to` range spans, both ends
   * inclusive.
   *
   * @param from - Range start (`YYYY-MM-DD`).
   * @param to - Range end (`YYYY-MM-DD`).
   * @returns The span in days; 1 when both ends name the same day.
   */
  public static spanDays(from: string, to: string): number {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);

    return Math.round((end - start) / DAY_MS) + 1;
  }

  /**
   * Resolves the Monday of the ISO week a day belongs to.
   *
   * @param date - Calendar day (`YYYY-MM-DD`).
   * @returns The week's Monday (`YYYY-MM-DD`).
   */
  public static weekStart(date: string): string {
    const parsed = new Date(`${date}T00:00:00Z`);
    const offset = (parsed.getUTCDay() + 6) % 7;
    const monday = new Date(parsed.getTime() - offset * DAY_MS);

    return monday.toISOString().slice(0, 10);
  }
}
