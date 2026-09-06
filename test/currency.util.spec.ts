import { ServerError } from '~errors';
import type { CurrencyRateInput, NbuRateRow } from '~types';
import { CurrencyUtils } from '~utils';

/**
 * Builds an NBU response row with consistent defaults, overridable per test.
 *
 * @param overrides - Fields to replace.
 * @returns The row.
 */
function row(overrides: Partial<NbuRateRow> = {}): NbuRateRow {
  const base: NbuRateRow = {
    exchangedate: '07.09.2026',
    cc: 'USD',
    rate: 44.5616,
    units: 1,
    rate_per_unit: 44.5616,
  };

  return { ...base, ...overrides };
}

describe('CurrencyUtils.normalize', () => {
  it('keeps a modern per-unit quote as it stands', () => {
    expect(CurrencyUtils.normalize(row())).toEqual({
      code: 'USD',
      rate: 44.5616,
      effectiveOn: '2026-09-07',
    });
  });

  /**
   * The whole reason this function exists. Until 2019-12-27 the NBU quoted
   * USD and EUR per 100 units, so persisting its `rate` field unchanged would
   * store a hundred times the real rate — and the number still looks
   * plausible, so nothing downstream would notice.
   */
  it('divides a per-100 quote by its units', () => {
    const normalized = CurrencyUtils.normalize(row({
      exchangedate: '04.01.2010',
      rate: 798.5,
      units: 100,
      rate_per_unit: 7.985,
    }));

    expect(normalized.rate).toBe(7.985);
    expect(normalized.rate).not.toBe(798.5);
  });

  /**
   * `numeric(18,6)`, not the shared price scale of 2, exists for this row.
   */
  it('keeps all six decimals of a high-inflation rate', () => {
    const normalized = CurrencyUtils.normalize(row({
      exchangedate: '31.12.2014',
      rate: 1576.8556,
      units: 100,
      rate_per_unit: 15.768556,
    }));

    expect(normalized.rate).toBe(15.768556);
  });

  it('rejects a row whose two rate fields disagree', () => {
    expect(() =>
      CurrencyUtils.normalize(row({ rate: 100, units: 1, rate_per_unit: 44 }))
    ).toThrow(ServerError);
  });

  it('rejects an unusable unit count', () => {
    expect(() => CurrencyUtils.normalize(row({ units: 0 }))).toThrow(
      ServerError,
    );
  });

  it('rejects a non-positive rate', () => {
    expect(() => CurrencyUtils.normalize(row({ rate: 0, rate_per_unit: 0 })))
      .toThrow(ServerError);
  });

  it('upper-cases the currency code', () => {
    expect(CurrencyUtils.normalize(row({ cc: 'usd' })).code).toBe('USD');
  });
});

describe('CurrencyUtils.convert', () => {
  it('divides when leaving the base currency', () => {
    expect(CurrencyUtils.convert(1200, 1, 24)).toBe(50);
  });

  it('multiplies when entering the base currency', () => {
    expect(CurrencyUtils.convert(50, 24, 1)).toBe(1200);
  });

  it('cross-converts two non-base currencies', () => {
    expect(CurrencyUtils.convert(100, 44, 52)).toBe(84.62);
  });

  it('rounds away binary-float noise', () => {
    expect(CurrencyUtils.convert(219.9, 1, 1)).toBe(219.9);
    expect(CurrencyUtils.convert(1000, 1, 3)).toBe(333.33);
  });

  it('rejects a zero or negative rate rather than dividing by it', () => {
    expect(() => CurrencyUtils.convert(100, 1, 0)).toThrow(ServerError);
    expect(() => CurrencyUtils.convert(100, -1, 1)).toThrow(ServerError);
  });
});

describe('CurrencyUtils date handling', () => {
  it('parses the NBU wire format', () => {
    expect(CurrencyUtils.fromWireDate('04.01.2010')).toBe('2010-01-04');
  });

  it('rejects a wire date it does not recognise', () => {
    expect(() => CurrencyUtils.fromWireDate('2010-01-04')).toThrow(ServerError);
  });

  it('renders the compact query form', () => {
    expect(CurrencyUtils.toQueryDate('2026-09-07')).toBe('20260907');
  });

  it('rejects a query date that is not a bare day', () => {
    expect(() => CurrencyUtils.toQueryDate('2026-09-07T00:00:00Z')).toThrow(
      ServerError,
    );
  });

  it('shifts days across a month and a leap day, in UTC', () => {
    expect(CurrencyUtils.shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(CurrencyUtils.shiftDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(CurrencyUtils.shiftDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('counts an inclusive span', () => {
    expect(CurrencyUtils.daysBetween('2026-09-01', '2026-09-01')).toBe(1);
    expect(CurrencyUtils.daysBetween('2026-09-01', '2026-09-07')).toBe(7);
  });
});

describe('CurrencyUtils.fillGaps', () => {
  /**
   * Builds a rate for one day of the test currency.
   *
   * @param day - The day, as `YYYY-MM-DD`.
   * @param rate - Hryvnia per unit.
   * @returns The rate.
   */
  const at = (day: string, rate: number): CurrencyRateInput => ({
    code: 'USD',
    rate,
    effectiveOn: day,
  });

  it('leaves a series that already has every day alone', () => {
    const rates = [at('2020-01-01', 10), at('2020-01-02', 20)];

    expect(CurrencyUtils.fillGaps(rates)).toEqual(rates);
  });

  /**
   * The rule the user asked for: no rate for the 12th, take the 11th; none for
   * the 11th either, take the 10th.
   */
  it('carries the last known rate across a run of missing days', () => {
    const filled = CurrencyUtils.fillGaps([
      at('2020-01-10', 10),
      at('2020-01-13', 40),
    ]);

    expect(filled).toEqual([
      at('2020-01-10', 10),
      at('2020-01-11', 10),
      at('2020-01-12', 10),
      at('2020-01-13', 40),
    ]);
  });

  it('bridges several separate holes', () => {
    const filled = CurrencyUtils.fillGaps([
      at('2020-01-01', 10),
      at('2020-01-03', 30),
      at('2020-01-06', 60),
    ]);

    expect(filled.map((rate) => rate.effectiveOn)).toEqual([
      '2020-01-01',
      '2020-01-02',
      '2020-01-03',
      '2020-01-04',
      '2020-01-05',
      '2020-01-06',
    ]);
    expect(filled.map((rate) => rate.rate)).toEqual([10, 10, 30, 30, 30, 60]);
  });

  it('bridges a hole that straddles a year boundary', () => {
    const filled = CurrencyUtils.fillGaps([
      at('2019-12-30', 10),
      at('2020-01-02', 20),
    ]);

    expect(filled.map((rate) => rate.effectiveOn)).toEqual([
      '2019-12-30',
      '2019-12-31',
      '2020-01-01',
      '2020-01-02',
    ]);
  });

  it('sorts an unordered input before bridging', () => {
    const filled = CurrencyUtils.fillGaps([
      at('2020-01-04', 40),
      at('2020-01-01', 10),
    ]);

    expect(filled.map((rate) => rate.effectiveOn)).toEqual([
      '2020-01-01',
      '2020-01-02',
      '2020-01-03',
      '2020-01-04',
    ]);
  });

  /**
   * Only the interior is filled. Widening the range would make the result
   * depend on what the caller happened to ask for rather than on what the
   * source published.
   */
  it('never extends past the first or last day it was given', () => {
    const filled = CurrencyUtils.fillGaps([
      at('2020-01-05', 10),
      at('2020-01-07', 20),
    ]);

    expect(filled.at(0)?.effectiveOn).toBe('2020-01-05');
    expect(filled.at(-1)?.effectiveOn).toBe('2020-01-07');
  });

  it('passes an empty or single-day series through', () => {
    expect(CurrencyUtils.fillGaps([])).toEqual([]);
    expect(CurrencyUtils.fillGaps([at('2020-01-01', 10)])).toEqual([
      at('2020-01-01', 10),
    ]);
  });

  it('refuses to bridge across two currencies', () => {
    expect(() =>
      CurrencyUtils.fillGaps([
        at('2020-01-01', 10),
        { code: 'EUR', rate: 30, effectiveOn: '2020-01-05' },
      ])
    ).toThrow(ServerError);
  });
});

describe('CurrencyUtils.splitByYear', () => {
  it('leaves a range inside one year alone', () => {
    expect(CurrencyUtils.splitByYear('2026-08-28', '2026-09-07')).toEqual([
      { from: '2026-08-28', to: '2026-09-07' },
    ]);
  });

  it('cuts a multi-year range at each year boundary', () => {
    expect(CurrencyUtils.splitByYear('2024-11-01', '2026-02-01')).toEqual([
      { from: '2024-11-01', to: '2024-12-31' },
      { from: '2025-01-01', to: '2025-12-31' },
      { from: '2026-01-01', to: '2026-02-01' },
    ]);
  });

  it('covers every day of the range exactly once', () => {
    const chunks = CurrencyUtils.splitByYear('1996-01-01', '2026-09-07');
    const total = chunks.reduce(
      (sum, chunk) => sum + CurrencyUtils.daysBetween(chunk.from, chunk.to),
      0,
    );

    expect(total).toBe(CurrencyUtils.daysBetween('1996-01-01', '2026-09-07'));
  });

  it('returns nothing for an inverted range', () => {
    expect(CurrencyUtils.splitByYear('2026-09-07', '2026-09-01')).toEqual([]);
  });
});
