import 'reflect-metadata';

import { COLLECTION_STATS_MAX_MONTHS } from '~constants';
import { CollectionTimelineGranularity } from '~enums';
import { BadRequestError } from '~errors';
import type { CollectionStatsBounds, CollectionSummaryRow, ID } from '~types';

import { CollectionStatsService } from '../src/domain/collection/collection-stats.service';

import type { CoreCurrencyService } from '~core/currency';
import type { CoreUserCollectionPurchaseService } from '~core/user-collection';

const USER = 'user-1' as ID;

/**
 * A summary row with every KPI at zero — the default for a test that does
 * not exercise the summary itself.
 */
const EMPTY_SUMMARY: CollectionSummaryRow = {
  items: 0,
  bottles: 0,
  pricedBottles: 0,
  totalSpent: 0,
  avgPrice: null,
};

/**
 * Builds the months a collection's purchases span.
 *
 * @param over - Fields to override.
 * @returns A complete bounds row.
 */
function makeBounds(
  over: Partial<CollectionStatsBounds> = {},
): CollectionStatsBounds {
  return {
    firstMonth: '2024-05',
    lastMonth: '2026-02',
    ...over,
  };
}

/**
 * The currency lookup as `CoreCurrencyService.findActive` answers it: the base
 * currency plus one foreign one, which is all the resolution logic reads
 * (`isBase`, `code`, `id`).
 */
const CURRENCIES = [
  { id: 'cur-uah' as ID, code: 'UAH', isBase: true },
  { id: 'cur-usd' as ID, code: 'USD', isBase: false },
];

interface Mocks {
  service: CollectionStatsService;
  purchases: Record<string, jest.Mock>;
}

/**
 * Wires a `CollectionStatsService` over a mocked purchase-aggregate
 * service, defaulted to a purchase-less collection so a test only overrides
 * what it actually exercises.
 *
 * @returns The service and the mock worth asserting on.
 */
function makeService(): Mocks {
  const purchases = {
    boundsForUser: jest.fn().mockResolvedValue(null),
    summaryForUser: jest.fn().mockResolvedValue(EMPTY_SUMMARY),
    mostExpensiveForUser: jest.fn().mockResolvedValue(null),
    cheapestForUser: jest.fn().mockResolvedValue(null),
    countByCountryForUser: jest.fn().mockResolvedValue([]),
    countByRegionForUser: jest.fn().mockResolvedValue([]),
    countByStoreForUser: jest.fn().mockResolvedValue([]),
    timelineForUser: jest.fn().mockResolvedValue([]),
  };

  const currencies = {
    findActive: jest.fn().mockResolvedValue(CURRENCIES),
  };

  const service = new CollectionStatsService(
    purchases as unknown as CoreUserCollectionPurchaseService,
    currencies as unknown as CoreCurrencyService,
  );

  return { service, purchases };
}

/**
 * Every test in this file reads "the current month" through
 * {@link CollectionStatsService}, so the clock is pinned for all of them
 * rather than recomputed from `new Date()` in each assertion — a test that
 * recomputes the same expression it is checking proves nothing.
 */
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CollectionStatsService.getOwn range defaults', () => {
  it('defaults to the first purchase month and the current month', async () => {
    const { service, purchases } = makeService();

    purchases.boundsForUser.mockResolvedValue(makeBounds());

    const result = await service.getOwn(USER, {});

    expect(result.timeline.from).toBe('2024-05');
    expect(result.timeline.to).toBe('2026-03');
    expect(purchases.timelineForUser).toHaveBeenCalledWith(
      USER,
      '2024-05',
      '2026-03',
      CollectionTimelineGranularity.MONTH,
      null,
    );
  });

  it('uses an explicit range inside the bounds as given', async () => {
    const { service, purchases } = makeService();

    purchases.boundsForUser.mockResolvedValue(makeBounds());

    const result = await service.getOwn(USER, {
      from: '2025-01',
      to: '2025-06',
    });

    expect(result.timeline.from).toBe('2025-01');
    expect(result.timeline.to).toBe('2025-06');
    expect(purchases.timelineForUser).toHaveBeenCalledWith(
      USER,
      '2025-01',
      '2025-06',
      CollectionTimelineGranularity.MONTH,
      null,
    );
  });
});

describe('CollectionStatsService.getOwn range clamping', () => {
  it('clamps a from earlier than the first purchase month', async () => {
    const { service, purchases } = makeService();

    purchases.boundsForUser.mockResolvedValue(makeBounds());

    const result = await service.getOwn(USER, { from: '2020-01' });

    expect(result.timeline.from).toBe('2024-05');
    expect(result.timeline.to).toBe('2026-03');
  });

  it('clamps a to later than the current month', async () => {
    const { service, purchases } = makeService();

    purchases.boundsForUser.mockResolvedValue(makeBounds());

    const result = await service.getOwn(USER, { to: '2030-01' });

    expect(result.timeline.from).toBe('2024-05');
    expect(result.timeline.to).toBe('2026-03');
  });
});

describe('CollectionStatsService.getOwn range validation', () => {
  it('rejects an inverted range', async () => {
    const { service } = makeService();

    const failure = service.getOwn(USER, { from: '2026-01', to: '2025-01' });

    await expect(failure).rejects.toThrow(BadRequestError);
    await expect(failure).rejects.toThrow('"from" must not be after "to"');
  });

  it('rejects a range wider than the cap, naming it', async () => {
    const { service } = makeService();

    const failure = service.getOwn(USER, { from: '1900-01', to: '2000-01' });

    await expect(failure).rejects.toThrow(BadRequestError);
    await expect(failure).rejects.toThrow(
      `Range must not exceed ${COLLECTION_STATS_MAX_MONTHS} months`,
    );
  });
});

describe('CollectionStatsService.getOwn with no purchases', () => {
  it('resolves a current-month range instead of throwing', async () => {
    const { service, purchases } = makeService();

    purchases.boundsForUser.mockResolvedValue(null);

    const result = await service.getOwn(USER, {});

    expect(result.bounds).toBeNull();
    expect(result.timeline.from).toBe('2026-03');
    expect(result.timeline.to).toBe('2026-03');
  });
});

describe('CollectionStatsService.getOwn granularity', () => {
  it('defaults granularity to month', async () => {
    const { service, purchases } = makeService();

    const result = await service.getOwn(USER, {});

    expect(result.timeline.granularity)
      .toBe(CollectionTimelineGranularity.MONTH);
    expect(purchases.timelineForUser).toHaveBeenCalledWith(
      USER,
      '2026-03',
      '2026-03',
      CollectionTimelineGranularity.MONTH,
      null,
    );
  });

  it('passes year granularity through to the repository call', async () => {
    const { service, purchases } = makeService();

    const result = await service.getOwn(USER, {
      granularity: CollectionTimelineGranularity.YEAR,
    });

    expect(result.timeline.granularity)
      .toBe(CollectionTimelineGranularity.YEAR);
    expect(purchases.timelineForUser).toHaveBeenCalledWith(
      USER,
      '2026-03',
      '2026-03',
      CollectionTimelineGranularity.YEAR,
      null,
    );
  });
});

describe('CollectionStatsService.getOwn independent reads', () => {
  it('issues every independent read exactly once', async () => {
    const { service, purchases } = makeService();

    await service.getOwn(USER, {});

    expect(purchases.boundsForUser).toHaveBeenCalledTimes(1);
    expect(purchases.boundsForUser).toHaveBeenCalledWith(USER);

    [
      purchases.summaryForUser,
      purchases.mostExpensiveForUser,
      purchases.cheapestForUser,
      purchases.countByCountryForUser,
      purchases.countByRegionForUser,
      purchases.countByStoreForUser,
      purchases.timelineForUser,
    ].forEach((mock) => {
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('CollectionStatsService.getOwn display currency', () => {
  it('echoes the base currency and converts nothing by default', async () => {
    const { service, purchases } = makeService();

    const result = await service.getOwn(USER, {});

    expect(result.currency).toBe('UAH');
    expect(purchases.summaryForUser).toHaveBeenCalledWith(USER, null);
    expect(purchases.countByStoreForUser).toHaveBeenCalledWith(USER, null);
  });

  it("resolves a foreign currency to the aggregates' convert id", async () => {
    const { service, purchases } = makeService();

    const result = await service.getOwn(USER, { currency: 'USD' });

    expect(result.currency).toBe('USD');
    expect(purchases.summaryForUser).toHaveBeenCalledWith(USER, 'cur-usd');
    expect(purchases.mostExpensiveForUser)
      .toHaveBeenCalledWith(USER, 'cur-usd');
    expect(purchases.cheapestForUser).toHaveBeenCalledWith(USER, 'cur-usd');
    expect(purchases.countByStoreForUser)
      .toHaveBeenCalledWith(USER, 'cur-usd');
    expect(purchases.timelineForUser).toHaveBeenCalledWith(
      USER,
      '2026-03',
      '2026-03',
      CollectionTimelineGranularity.MONTH,
      'cur-usd',
    );
  });

  it('applies no rate when the base currency is named', async () => {
    const { service, purchases } = makeService();

    const result = await service.getOwn(USER, { currency: 'UAH' });

    expect(result.currency).toBe('UAH');
    expect(purchases.summaryForUser).toHaveBeenCalledWith(USER, null);
  });

  it('rejects a currency prices may not be displayed in', async () => {
    const { service, purchases } = makeService();

    await expect(service.getOwn(USER, { currency: 'XXX' }))
      .rejects.toThrow(BadRequestError);

    expect(purchases.summaryForUser).not.toHaveBeenCalled();
  });
});
