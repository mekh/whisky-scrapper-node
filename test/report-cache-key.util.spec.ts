import 'reflect-metadata';

import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type { ReportFilter, ReportOptions } from '~types';
import { ReportCacheKeyUtils } from '~utils';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

/**
 * The key suffix for a catalog request.
 *
 * @param filter - The catalogue filter.
 * @param options - Option overrides on top of the defaults.
 * @param day - The day bucket, for the kinds that read the clock.
 * @param kind - The report kind.
 * @returns The suffix.
 */
function suffix(
  filter: ReportFilter = {},
  options: Partial<ReportOptions> = {},
  day: string | null = null,
  kind: ReportKind = ReportKind.CATALOG,
): string {
  return ReportCacheKeyUtils.suffix(
    kind,
    filter,
    { ...OPTIONS, ...options },
    day,
  );
}

describe('ReportCacheKeyUtils — what changes the key', () => {
  it('separates the report kinds', () => {
    const kinds = Object.values(ReportKind)
      .map((kind) => suffix({}, {}, null, kind));

    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('separates two different filters', () => {
    expect(suffix({ stores: ['a'] })).not.toBe(suffix({ stores: ['b'] }));
  });

  it('separates the day for a report that reads the clock', () => {
    expect(suffix({}, {}, '2026-09-10', ReportKind.NEW))
      .not.toBe(suffix({}, {}, '2026-09-11', ReportKind.NEW));
  });

  it('keeps the kind and the day readable in the suffix', () => {
    /**
     * So `valkey-cli --scan` shows what is cached instead of a wall of hex.
     */
    expect(suffix({}, {}, '2026-09-10', ReportKind.DROPS))
      .toMatch(/^drops:2026-09-10:[0-9a-f]{32}$/);

    expect(suffix()).toMatch(/^catalog:-:[0-9a-f]{32}$/);
  });
});

describe('ReportCacheKeyUtils — what must not change the key', () => {
  it('ignores sorting and pagination', () => {
    /**
     * The cached entry is the whole matched set, sorted and sliced after it
     * is read. If these changed the key, every page of a report would be its
     * own entry and its own full recomputation.
     */
    const base = suffix();

    expect(suffix({}, { page: 7 })).toBe(base);
    expect(suffix({}, { perPage: 200 })).toBe(base);
    expect(suffix({}, { order: SortOrder.DESC })).toBe(base);
    expect(suffix({}, { sort: 'price' as ReportOptions['sort'] })).toBe(base);
  });

  it('ignores the order and repetition of a multi-value filter', () => {
    /**
     * Each of these reaches the query as `= ANY($n)`, which is set
     * semantics, so two requests the SQL cannot tell apart must share one
     * entry.
     */
    expect(suffix({ stores: ['b', 'a', 'b'] }))
      .toBe(suffix({ stores: ['a', 'b'] }));
  });

  it('folds country case, as the country predicate does', () => {
    expect(suffix({ countries: ['GB-SCT'] }))
      .toBe(suffix({ countries: ['gb-sct'] }));
  });

  it('reads an empty list as no constraint', () => {
    /**
     * `findCurrentRows` passes `filter.x?.length ? … : null`, so an empty
     * array constrains nothing and has to hash like an absent one.
     */
    expect(suffix({ stores: [], types: [], flavors: [] })).toBe(suffix());
  });

  it('reads a false verifiedFacts as no constraint', () => {
    expect(suffix({ verifiedFacts: false })).toBe(suffix());
    expect(suffix({ verifiedFacts: true })).not.toBe(suffix());
  });

  it('reads a zero minimum discount as no constraint', () => {
    /**
     * `applyMinDiscount` returns the rows untouched on a falsy minimum.
     */
    expect(suffix({}, { minDiscount: 0 })).toBe(suffix());
    expect(suffix({}, { minDiscount: 10 })).not.toBe(suffix());
  });

  it('keeps a zero price bound, which does constrain', () => {
    expect(suffix({ minPrice: 0 })).not.toBe(suffix());
  });

  it('keeps an empty name, which is not the same as no name', () => {
    /**
     * `p.name ILIKE '%%'` is NULL for a bottling whose cleaned name is null,
     * so an empty term quietly drops those rows where an absent one keeps
     * them. Normalizing the two together would serve one request's answer to
     * the other.
     */
    expect(suffix({ name: '' })).not.toBe(suffix());
  });
});

describe('ReportCacheKeyUtils — the canonical description', () => {
  it('states only the fields that shape the result', () => {
    const canonical = ReportCacheKeyUtils.canonical(
      ReportKind.CATALOG,
      { stores: ['a'] },
      OPTIONS,
      null,
    );

    expect(canonical).toEqual({
      kind: ReportKind.CATALOG,
      stores: ['a'],
      window: ReportWindow.WEEK,
    });
  });

  it('carries the price bounds even for best, which drops them in SQL', () => {
    /**
     * `best` asks for its candidates without the bounds and applies them to
     * the winner in JavaScript, so they still decide the answer and must
     * still decide the key.
     */
    const canonical = ReportCacheKeyUtils.canonical(
      ReportKind.BEST,
      { maxPrice: 2000 },
      OPTIONS,
      null,
    );

    expect(canonical.maxPrice).toBe(2000);
    expect(suffix({ maxPrice: 2000 }, {}, null, ReportKind.BEST))
      .not.toBe(suffix({}, {}, null, ReportKind.BEST));
  });
});
