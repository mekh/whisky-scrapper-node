import { ReportSortField, SortOrder } from '~enums';
import { ReportPageUtils } from '~utils';

import type {
  PreferenceFilterIds,
  ReportGroup,
  ReportOptions,
  ReportPageIndex,
} from '~types';

/**
 * The options a page selection reads.
 */
type PageOptions = Pick<ReportOptions, 'sort' | 'order' | 'page' | 'perPage'>;

/**
 * Deterministic generator (mulberry32), so a failing draw can be replayed.
 */
class Rng {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * Draws a float in `[0, 1)`.
   *
   * @returns The draw.
   */
  public next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;

    let t = this.state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Draws an integer in `[min, max]`.
   *
   * @param min - Lowest value.
   * @param max - Highest value.
   * @returns The draw.
   */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Picks one item.
   *
   * @param items - The pool.
   * @returns One item.
   */
  public pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
}

const MAKERS = ['m1', 'm2', 'm3', 'm4', null];

const WORDS = ['Ardbeg', 'ardbeg', 'Bowmore', 'Dalmore', 'glen', 'Glen', null];

/**
 * A group carrying only what ordering and personalisation read; the rest
 * of the shape is irrelevant here and cast away.
 *
 * @param rng - The generator.
 * @param n - The group's ordinal, which makes its ids unique.
 * @returns A minimal group.
 */
function makeGroup(rng: Rng, n: number): ReportGroup {
  const number = (): number | null =>
    rng.next() < 0.2 ? null : rng.int(0, 6) * 100;

  const word = (): string | null => rng.pick(WORDS);

  return {
    id: `offer-${String(n).padStart(4, '0')}`,
    productId: `product-${String(n).padStart(4, '0')}`,
    producerId: rng.pick(MAKERS),
    bottlerId: rng.next() < 0.7 ? null : rng.pick(MAKERS),
    abv: number(),
    age: number(),
    countryName: word(),
    daysDiscount: number(),
    discountPct: number(),
    name: word(),
    previousPrice: number(),
    price: number(),
    storeName: word(),
    type: word(),
    volumeMl: number(),
    offers: [],
  } as unknown as ReportGroup;
}

/**
 * The behaviour being replaced, kept here as the oracle: personalise, then
 * sort, then slice — `ReportService.personalize`, `sort` and `compare` as
 * they stood before the page index existed.
 *
 * @param groups - The set in natural order.
 * @param preferences - The caller's lists.
 * @param favoritesOnly - Whether only favourites are shown.
 * @param options - Sort, direction, page and page size.
 * @returns The page's groups and the visible total.
 */
function legacyPage(
  groups: ReportGroup[],
  preferences: PreferenceFilterIds,
  favoritesOnly: boolean | undefined,
  options: PageOptions,
): { page: ReportGroup[]; total: number } {
  const hiddenProducts = new Set(preferences.blacklistProducts);
  const hiddenMakers = new Set(preferences.blacklistProducers);
  const favorites = new Set(preferences.favorites);

  const visible = groups.filter((group) => {
    const hidden = hiddenProducts.has(group.productId)
      || (group.producerId !== null && hiddenMakers.has(group.producerId))
      || (group.bottlerId !== null && hiddenMakers.has(group.bottlerId));

    if (hidden) {
      return false;
    }

    return !favoritesOnly || favorites.has(group.productId);
  });

  const compare = (a: number | string, b: number | string): number =>
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).toLowerCase().localeCompare(String(b).toLowerCase());

  const sorted = options.sort
    ? [...visible].sort((a, b) => {
      const field = options.sort as ReportSortField;
      const direction = options.order === SortOrder.DESC ? -1 : 1;
      const av = a[field] as number | string | null;
      const bv = b[field] as number | string | null;

      if (av === null || av === undefined) {
        return bv === null || bv === undefined ? a.id.localeCompare(b.id) : 1;
      }

      if (bv === null || bv === undefined) {
        return -1;
      }

      return compare(av, bv) * direction || a.id.localeCompare(b.id);
    })
    : visible;

  const offset = (options.page - 1) * options.perPage;

  return {
    page: sorted.slice(offset, offset + options.perPage),
    total: sorted.length,
  };
}

/**
 * Resolves a selection back to groups, the way the cache hands them over.
 *
 * @param groups - The set.
 * @param positions - The selected positions.
 * @returns The groups at those positions, in order.
 */
function resolve(groups: ReportGroup[], positions: number[]): ReportGroup[] {
  return positions.map((position) => groups[position] as ReportGroup);
}

const NONE: PreferenceFilterIds = {
  favorites: [],
  blacklistProducts: [],
  blacklistProducers: [],
};

describe('ReportPageUtils.buildIndex', () => {
  const rng = new Rng(7);
  const groups = Array.from({ length: 40 }, (_, n) => makeGroup(rng, n));
  const index: ReportPageIndex = ReportPageUtils.buildIndex(groups);

  it('records every position once in every order', () => {
    const expected = groups.map((_, position) => position);

    Object.values(index.orders).forEach((order) => {
      expect([...order].sort((a, b) => a - b)).toEqual(expected);
    });
  });

  it('holds one order per sortable field and direction, plus natural', () => {
    const fields = Object.values(ReportSortField).length;
    const directions = Object.values(SortOrder).length;

    expect(Object.keys(index.orders)).toHaveLength(fields * directions + 1);
    expect(index.orders.natural).toEqual(groups.map((_, position) => position));
  });

  it('carries the ids personalisation tests, by position', () => {
    expect(index.ids).toEqual(groups.map((group) => group.productId));
    expect(index.producers).toEqual(groups.map((group) => group.producerId));
    expect(index.bottlers).toEqual(groups.map((group) => group.bottlerId));
  });

  it('puts nulls last in both directions and breaks ties by offer id', () => {
    const asc = resolve(groups, index.orders['price:asc']);
    const desc = resolve(groups, index.orders['price:desc']);

    const nulls = groups.filter((group) => group.price === null).length;

    expect(asc.slice(-nulls).every((group) => group.price === null)).toBe(true);
    expect(desc.slice(-nulls).every((group) => group.price === null)).toBe(
      true,
    );

    const priced = asc.slice(0, asc.length - nulls);

    priced.slice(1).forEach((group, i) => {
      const previous = priced[i] as ReportGroup;

      expect(
        (previous.price as number) < (group.price as number)
          || (previous.price === group.price
            && previous.id.localeCompare(group.id) < 0),
      ).toBe(true);
    });
  });

  it('indexes an empty set', () => {
    const empty = ReportPageUtils.buildIndex([]);

    expect(empty.ids).toEqual([]);
    expect(empty.orders.natural).toEqual([]);
    expect(empty.orders['name:asc']).toEqual([]);
  });
});

describe('ReportPageUtils.orderKey', () => {
  it('names the natural order when nothing is sorted', () => {
    expect(ReportPageUtils.orderKey(undefined, SortOrder.ASC)).toBe('natural');
  });

  it('names a field and direction', () => {
    expect(ReportPageUtils.orderKey(ReportSortField.PRICE, SortOrder.DESC))
      .toBe('price:desc');
  });
});

describe('ReportPageUtils.select', () => {
  const rng = new Rng(11);
  const groups = Array.from({ length: 60 }, (_, n) => makeGroup(rng, n));
  const index = ReportPageUtils.buildIndex(groups);

  it('returns the first page in natural order with no preferences', () => {
    const pick = ReportPageUtils.select(index, NONE, false, {
      order: SortOrder.ASC,
      page: 1,
      perPage: 7,
    });

    expect(pick.positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pick.total).toBe(60);
  });

  it('counts the whole visible set, not the page', () => {
    const pick = ReportPageUtils.select(index, NONE, false, {
      sort: ReportSortField.NAME,
      order: SortOrder.ASC,
      page: 3,
      perPage: 7,
    });

    expect(pick.positions).toHaveLength(7);
    expect(pick.total).toBe(60);
  });

  it('answers a page past the end with nothing and the total intact', () => {
    const pick = ReportPageUtils.select(index, NONE, false, {
      order: SortOrder.ASC,
      page: 50,
      perPage: 7,
    });

    expect(pick.positions).toEqual([]);
    expect(pick.total).toBe(60);
  });

  it('hides a bottling by product id', () => {
    const hidden = (groups[3] as ReportGroup).productId;
    const pick = ReportPageUtils.select(
      index,
      { ...NONE, blacklistProducts: [hidden] },
      false,
      { order: SortOrder.ASC, page: 1, perPage: 60 },
    );

    expect(pick.total).toBe(59);
    expect(pick.positions).not.toContain(3);
  });

  it('hides a maker in the producer slot and in the bottler slot', () => {
    const pick = ReportPageUtils.select(
      index,
      { ...NONE, blacklistProducers: ['m2'] },
      false,
      { order: SortOrder.ASC, page: 1, perPage: 60 },
    );

    const kept = resolve(groups, pick.positions);

    expect(kept.some((g) => g.producerId === 'm2')).toBe(false);
    expect(kept.some((g) => g.bottlerId === 'm2')).toBe(false);
    expect(kept.length).toBe(pick.total);
    expect(kept.length).toBeLessThan(60);
  });

  it('keeps only favourites when asked, and none when there are none', () => {
    const favorites = [groups[5], groups[9]].map(
      (group) => (group as ReportGroup).productId,
    );

    const some = ReportPageUtils.select(
      index,
      { ...NONE, favorites },
      true,
      { order: SortOrder.ASC, page: 1, perPage: 60 },
    );

    expect(some.positions).toEqual([5, 9]);
    expect(some.total).toBe(2);

    const none = ReportPageUtils.select(index, NONE, true, {
      order: SortOrder.ASC,
      page: 1,
      perPage: 60,
    });

    expect(none.positions).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('leaves the set alone on an empty index', () => {
    const pick = ReportPageUtils.select(
      ReportPageUtils.buildIndex([]),
      NONE,
      false,
      { order: SortOrder.ASC, page: 1, perPage: 50 },
    );

    expect(pick).toEqual({ positions: [], total: 0 });
  });
});

describe('ReportPageUtils vs the legacy personalise → sort → slice', () => {
  const sorts = [undefined, ...Object.values(ReportSortField)];
  const orders = Object.values(SortOrder);

  it('produces the same page and total on 600 generated cases', () => {
    const rng = new Rng(2026);

    Array.from({ length: 600 }).forEach((_, iteration) => {
      const size = rng.int(0, 70);
      const groups = Array.from({ length: size }, (__, n) => makeGroup(rng, n));
      const index = ReportPageUtils.buildIndex(groups);

      const some = (): string[] =>
        groups
          .filter(() => rng.next() < 0.15)
          .map((group) => group.productId);

      const preferences: PreferenceFilterIds = {
        favorites: some(),
        blacklistProducts: some(),
        blacklistProducers: MAKERS.filter(
          (maker): maker is string => maker !== null && rng.next() < 0.3,
        ),
      };

      const favoritesOnly = rng.next() < 0.25;
      const options: PageOptions = {
        sort: rng.pick(sorts),
        order: rng.pick(orders),
        page: rng.int(1, 5),
        perPage: rng.pick([3, 5, 7, 50]),
      };

      const expected = legacyPage(groups, preferences, favoritesOnly, options);
      const pick = ReportPageUtils.select(
        index,
        preferences,
        favoritesOnly,
        options,
      );

      const context = `case ${iteration}: ${JSON.stringify(options)}`;

      expect({ context, total: pick.total }).toEqual({
        context,
        total: expected.total,
      });
      expect({ context, ids: resolve(groups, pick.positions).map((g) => g.id) })
        .toEqual({ context, ids: expected.page.map((g) => g.id) });
    });
  });
});
