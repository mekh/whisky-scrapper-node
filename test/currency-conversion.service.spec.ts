import type { CoreCurrencyService, CurrencyEntity } from '~core/currency';
import { BadRequestError } from '~errors';
import type { CurrencyRateProbe } from '~types';

import { CurrencyConversionService } from '../src/domain/currency/services/currency-conversion.service';
import type { CurrencyService } from '../src/domain/currency/services/currency.service';

/**
 * The one collaborator method the service calls, typed so the recorded calls
 * a test asserts on are not `any`.
 */
type ProbeRates = (
  pairs: { code: string; day: string }[],
) => Promise<CurrencyRateProbe[]>;

const BASE = 'UAH';

const PAST = '2020-06-15';

/**
 * The currencies the mocked lookup knows about.
 *
 * @returns A code-keyed map shaped like the real lookup's.
 */
function currencies(): Map<string, CurrencyEntity> {
  const rows = [
    { code: 'UAH', isBase: true },
    { code: 'USD', isBase: false },
    { code: 'EUR', isBase: false },
  ] as CurrencyEntity[];

  return new Map(rows.map((row) => [row.code, row]));
}

/**
 * Builds a probe as the repository would return one.
 *
 * @param code - Currency code.
 * @param day - The day asked about.
 * @param rate - The rate found, or null for a miss.
 * @param effectiveOn - The day the rate belongs to; defaults to `day`.
 * @returns The probe.
 */
function probe(
  code: string,
  day: string,
  rate: number | null,
  effectiveOn?: string,
): CurrencyRateProbe {
  return {
    code,
    requestedOn: day,
    rate,
    effectiveOn: rate === null ? null : effectiveOn ?? day,
  };
}

/**
 * Builds the service over mocked collaborators.
 *
 * @param probes - What `probeRates` should answer, by `code|day`.
 * @returns The service and the probe mock, so a test can count queries.
 */
function makeService(probes: CurrencyRateProbe[] = []): {
  service: CurrencyConversionService;
  probeRates: jest.MockedFunction<ProbeRates>;
} {
  const byKey = new Map(
    probes.map((entry) => [`${entry.code}|${entry.requestedOn}`, entry]),
  );

  const probeRates: jest.MockedFunction<ProbeRates> = jest.fn(
    (pairs) =>
      Promise.resolve(
        pairs.map((pair) =>
          byKey.get(`${pair.code}|${pair.day}`)
            ?? probe(pair.code, pair.day, null)
        ),
      ),
  );

  const core = { probeRates } as unknown as CoreCurrencyService;
  const lookup = {
    baseCode: jest.fn().mockResolvedValue(BASE),
    all: jest.fn().mockResolvedValue(currencies()),
  } as unknown as CurrencyService;

  return {
    service: new CurrencyConversionService(core, lookup),
    probeRates,
  };
}

describe('CurrencyConversionService.convert', () => {
  it('divides by the rate when leaving the base currency', async () => {
    const { service } = makeService([probe('USD', PAST, 26.7)]);

    const result = await service.convert({
      amount: 1335,
      from: 'UAH',
      to: 'USD',
      on: PAST,
    });

    expect(result).toEqual({
      amount: 1335,
      from: 'UAH',
      to: 'USD',
      requestedOn: PAST,
      effectiveOn: PAST,
      fromRate: 1,
      toRate: 26.7,
      converted: 50,
    });
  });

  it('multiplies by the rate when entering the base currency', async () => {
    const { service } = makeService([probe('USD', PAST, 26.7)]);

    const result = await service.convert({
      amount: 50,
      from: 'USD',
      to: 'UAH',
      on: PAST,
    });

    expect(result?.converted).toBe(1335);
  });

  it('applies no rate when both sides are the same currency', async () => {
    const { service, probeRates } = makeService();

    const result = await service.convert({
      amount: 1200,
      from: 'UAH',
      to: 'UAH',
      on: PAST,
    });

    expect(result).toMatchObject({
      converted: 1200,
      fromRate: null,
      toRate: null,
      effectiveOn: null,
    });
    expect(probeRates).not.toHaveBeenCalled();
  });

  /**
   * A cross-rate has two rates and no single "the rate", so both sides are
   * reported — naming one would silently pick a side.
   */
  it('cross-converts two non-base currencies through the hryvnia', async () => {
    const { service } = makeService([
      probe('USD', PAST, 26.7),
      probe('EUR', PAST, 30),
    ]);

    const result = await service.convert({
      amount: 100,
      from: 'USD',
      to: 'EUR',
      on: PAST,
    });

    expect(result).toMatchObject({
      converted: 89,
      fromRate: 26.7,
      toRate: 30,
    });
  });

  /**
   * A purchase older than the currency's published history has no official
   * rate and never will. Returning null lets the caller say so; substituting
   * the nearest available rate would invent a number.
   */
  it('returns null rather than inventing a missing rate', async () => {
    const { service } = makeService([probe('USD', '1990-01-01', null)]);

    const result = await service.convert({
      amount: 100,
      from: 'UAH',
      to: 'USD',
      on: '1990-01-01',
    });

    expect(result).toBeNull();
  });

  /**
   * The fallback only fires past the last synced day; when it does, the day
   * actually used has to be reported rather than the day asked for.
   */
  it('reports the day the rate belongs to, not the day asked for', async () => {
    const { service } = makeService([
      probe('USD', '2026-09-30', 44.5616, '2026-09-07'),
    ]);

    const result = await service.convert({
      amount: 100,
      from: 'UAH',
      to: 'USD',
      on: '2026-09-30',
    });

    expect(result?.requestedOn).toBe('2026-09-30');
    expect(result?.effectiveOn).toBe('2026-09-07');
  });

  it('rejects an unknown currency code', async () => {
    const { service } = makeService();

    await expect(
      service.convert({ amount: 1, from: 'UAH', to: 'XXX', on: PAST }),
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects an amount that is not a number', async () => {
    const { service } = makeService();

    await expect(
      service.convert({ amount: Number.NaN, from: 'UAH', to: 'USD' }),
    ).rejects.toThrow(BadRequestError);
  });
});

describe('CurrencyConversionService.convertMany', () => {
  /**
   * The reason this method exists. A collection screen converts every row it
   * shows, and a caller looping over `convert` would issue one query per row.
   */
  it('resolves many requests over the same day in one query', async () => {
    const { service, probeRates } = makeService([probe('USD', PAST, 26.7)]);

    const results = await service.convertMany(
      [267, 534, 801].map((amount) => ({
        amount,
        from: 'UAH',
        to: 'USD',
        on: PAST,
      })),
    );

    expect(results.map((result) => result?.converted)).toEqual([10, 20, 30]);
    expect(probeRates).toHaveBeenCalledTimes(1);
    expect(probeRates.mock.calls[0]?.[0]).toEqual([
      { code: 'USD', day: PAST },
    ]);
  });

  it('asks for each distinct currency-day pair exactly once', async () => {
    const { service, probeRates } = makeService([
      probe('USD', PAST, 26.7),
      probe('USD', '2021-06-15', 27.5),
      probe('EUR', PAST, 30),
    ]);

    await service.convertMany([
      { amount: 1, from: 'UAH', to: 'USD', on: PAST },
      { amount: 1, from: 'UAH', to: 'USD', on: PAST },
      { amount: 1, from: 'UAH', to: 'USD', on: '2021-06-15' },
      { amount: 1, from: 'UAH', to: 'EUR', on: PAST },
    ]);

    expect(probeRates).toHaveBeenCalledTimes(1);
    expect(probeRates.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('keeps results positionally aligned, nulls included', async () => {
    const { service } = makeService([probe('USD', PAST, 26.7)]);

    const results = await service.convertMany([
      { amount: 267, from: 'UAH', to: 'USD', on: PAST },
      { amount: 100, from: 'UAH', to: 'USD', on: '1990-01-01' },
      { amount: 534, from: 'UAH', to: 'USD', on: PAST },
    ]);

    expect(results.map((result) => result?.converted ?? null)).toEqual([
      10,
      null,
      20,
    ]);
  });

  /**
   * A rate for a past day is immutable — the NBU never restates a published
   * one — so a second batch over the same day must not re-query.
   */
  it('serves a repeated past day from the cache', async () => {
    const { service, probeRates } = makeService([probe('USD', PAST, 26.7)]);

    await service.convertMany([{
      amount: 1,
      from: 'UAH',
      to: 'USD',
      on: PAST,
    }]);
    await service.convertMany([{
      amount: 2,
      from: 'UAH',
      to: 'USD',
      on: PAST,
    }]);

    expect(probeRates).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for an empty batch without querying', async () => {
    const { service, probeRates } = makeService();

    expect(await service.convertMany([])).toEqual([]);
    expect(probeRates).not.toHaveBeenCalled();
  });
});
