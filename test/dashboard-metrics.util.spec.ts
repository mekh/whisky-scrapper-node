import { DashboardMetricsUtils } from '~utils';

import type {
  DashboardDailyRow,
  DashboardLifecycleRow,
  DashboardSeriesPoint,
} from '~types';

/**
 * Builds a snapshot-side daily row from a few overrides.
 *
 * @param over - Fields to override.
 * @returns A complete daily row.
 */
function makeDaily(over: Partial<DashboardDailyRow> = {}): DashboardDailyRow {
  return {
    date: '2026-08-21',
    inStockListings: 100,
    distinctProducts: 80,
    distinctBrands: 30,
    activeStores: 5,
    p25Price: 800,
    medianPrice: 1500,
    p75Price: 3000,
    promoListings: 25,
    ...over,
  };
}

/**
 * Builds a lifecycle-side daily row from a few overrides.
 *
 * @param over - Fields to override.
 * @returns A complete lifecycle row.
 */
function makeLifecycle(
  over: Partial<DashboardLifecycleRow> = {},
): DashboardLifecycleRow {
  return {
    date: '2026-08-21',
    trackedListings: 120,
    newListings: 3,
    departedListings: 2,
    ...over,
  };
}

describe('DashboardMetricsUtils.deriveOos', () => {
  it('returns the tracked/in-stock difference', () => {
    expect(DashboardMetricsUtils.deriveOos(120, 100)).toBe(20);
  });

  it('returns zero when everything tracked is in stock', () => {
    expect(DashboardMetricsUtils.deriveOos(100, 100)).toBe(0);
  });

  it('clamps the retention-boundary artifact to zero', () => {
    /**
     * The real 2026-06-12 case: 736 listings have a snapshot on the data
     * floor day while their `firstSeen` is the day after, so the raw
     * difference is negative. The clamp is load-bearing.
     */
    expect(DashboardMetricsUtils.deriveOos(0, 736)).toBe(0);
  });

  it('reproduces the latest-day identity with the stock flags', () => {
    /**
     * Measured on the production dump for 2026-08-21: 8,586 listings
     * tracked, 7,552 in stock, and exactly 1,034 rows have
     * `inStock = false`. This is the test that stops a "fix" back to the
     * `lastSeen >= day` variant, which collapses to 0 on the latest day.
     */
    expect(DashboardMetricsUtils.deriveOos(8586, 7552)).toBe(1034);
  });
});

describe('DashboardMetricsUtils.mergePoints', () => {
  it('merges both sides by date and derives the out-of-stock count', () => {
    const points = DashboardMetricsUtils.mergePoints(
      [makeDaily()],
      [makeLifecycle()],
    );

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      date: '2026-08-21',
      inStockListings: 100,
      trackedListings: 120,
      oosListings: 20,
      newListings: 3,
      departedListings: 2,
      medianPrice: 1500,
    });
  });

  it('keeps a lifecycle-only day as zeros instead of a hole', () => {
    const points = DashboardMetricsUtils.mergePoints(
      [],
      [makeLifecycle({ date: '2026-08-20', trackedListings: 50 })],
    );

    expect(points[0]).toMatchObject({
      date: '2026-08-20',
      inStockListings: 0,
      trackedListings: 50,
      oosListings: 50,
      medianPrice: null,
      p25Price: null,
      p75Price: null,
      promoListings: 0,
    });
  });

  it('keeps a snapshot-only day with zero lifecycle counts', () => {
    const points = DashboardMetricsUtils.mergePoints([makeDaily()], []);

    expect(points[0]).toMatchObject({
      trackedListings: 0,
      oosListings: 0,
      newListings: 0,
      departedListings: 0,
      inStockListings: 100,
    });
  });

  it('orders the union of days ascending', () => {
    const points = DashboardMetricsUtils.mergePoints(
      [makeDaily({ date: '2026-08-21' })],
      [makeLifecycle({ date: '2026-08-19' })],
    );

    expect(points.map((point) => point.date)).toEqual([
      '2026-08-19',
      '2026-08-21',
    ]);
  });
});

describe('DashboardMetricsUtils.downsampleToWeeks', () => {
  it('takes level metrics from the last day and sums flow metrics', () => {
    /**
     * 2026-08-17 is a Monday; the three points share its ISO week. Level
     * metrics must come from the 21st (the last observation), while the
     * flows must be the sum over all three days — asserting both in one
     * test so the distinction cannot rot.
     */
    const week = DashboardMetricsUtils.downsampleToWeeks(
      DashboardMetricsUtils.mergePoints(
        [
          makeDaily({ date: '2026-08-18', inStockListings: 90 }),
          makeDaily({ date: '2026-08-19', inStockListings: 95 }),
          makeDaily({ date: '2026-08-21', inStockListings: 100 }),
        ],
        [
          makeLifecycle({ date: '2026-08-18', newListings: 1 }),
          makeLifecycle({ date: '2026-08-19', newListings: 2 }),
          makeLifecycle({ date: '2026-08-21', newListings: 4 }),
        ],
      ),
    );

    expect(week).toHaveLength(1);
    expect(week[0]).toMatchObject({
      date: '2026-08-17',
      inStockListings: 100,
      newListings: 7,
      departedListings: 6,
    });
  });

  it('keeps partial trailing weeks as their own bucket', () => {
    const points: DashboardSeriesPoint[] = DashboardMetricsUtils.mergePoints(
      [
        makeDaily({ date: '2026-08-16' }),
        makeDaily({ date: '2026-08-17' }),
      ],
      [],
    );

    const weeks = DashboardMetricsUtils.downsampleToWeeks(points);

    expect(weeks.map((point) => point.date)).toEqual([
      '2026-08-10',
      '2026-08-17',
    ]);
  });

  it('passes a single day through as one bucket', () => {
    const weeks = DashboardMetricsUtils.downsampleToWeeks(
      DashboardMetricsUtils.mergePoints([makeDaily()], []),
    );

    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.date).toBe('2026-08-17');
  });
});

describe('DashboardMetricsUtils.metric', () => {
  it('computes the delta and its percentage', () => {
    expect(DashboardMetricsUtils.metric(110, 100)).toEqual({
      latest: 110,
      baseline: 100,
      delta: 10,
      deltaPct: 10,
    });
  });

  it('keeps deltaPct null on a zero baseline', () => {
    expect(DashboardMetricsUtils.metric(5, 0)).toEqual({
      latest: 5,
      baseline: 0,
      delta: 5,
      deltaPct: null,
    });
  });

  it('propagates nulls without inventing values', () => {
    expect(DashboardMetricsUtils.metric(null, null)).toEqual({
      latest: null,
      baseline: null,
      delta: null,
      deltaPct: null,
    });

    expect(DashboardMetricsUtils.metric(7, null).delta).toBeNull();
  });
});

describe('DashboardMetricsUtils date helpers', () => {
  it('counts inclusive day spans', () => {
    expect(DashboardMetricsUtils.spanDays('2026-08-21', '2026-08-21')).toBe(1);
    expect(DashboardMetricsUtils.spanDays('2026-06-12', '2026-08-21')).toBe(
      71,
    );
  });

  it('resolves the ISO week Monday', () => {
    expect(DashboardMetricsUtils.weekStart('2026-08-17')).toBe('2026-08-17');
    expect(DashboardMetricsUtils.weekStart('2026-08-16')).toBe('2026-08-10');
    expect(DashboardMetricsUtils.weekStart('2026-08-21')).toBe('2026-08-17');
  });
});
