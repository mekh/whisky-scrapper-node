import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreCurrencyService } from '~core/currency';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * A throwaway currency, so the suite never touches the real UAH/USD/EUR rows
 * or the history a backfill put there.
 */
const CODE = 'ZZT';

/**
 * The rate storage against a real database. Everything worth testing here is
 * raw SQL that no unit test can reach: the upsert that makes re-syncing safe,
 * the lateral lookup that resolves a day to the rate in force on it, and the
 * window query the backfill's gap check depends on.
 */
describe('currency rates (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let currencies: CoreCurrencyService;

  /**
   * Removes every row this suite could have written.
   */
  const cleanup = async (): Promise<void> => {
    await dataSource.query(
      `DELETE FROM currency_rate
       WHERE "currencyId" = (SELECT id FROM currency WHERE code = $1)`,
      [CODE],
    );
    await dataSource.query('DELETE FROM currency WHERE code = $1', [CODE]);
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    currencies = moduleRef.get(CoreCurrencyService);

    await cleanup();
    await dataSource.query(
      `INSERT INTO currency ("code", "numericCode", "nameUa", "symbol",
                             "isBase", "active")
       VALUES ($1, 999, 'Тестова', 'T', false, false)`,
      [CODE],
    );
  });

  afterAll(async () => {
    await cleanup();
    await closeIntegrationModule(moduleRef);
  });

  beforeEach(async () => {
    await dataSource.query(
      `DELETE FROM currency_rate
       WHERE "currencyId" = (SELECT id FROM currency WHERE code = $1)`,
      [CODE],
    );
  });

  describe('upsertRates', () => {
    it('writes rates and reads them back at full scale', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 15.768556, effectiveOn: '2020-01-01' },
      ]);

      const series = await currencies.findRateSeries(
        CODE,
        '2020-01-01',
        '2020-01-01',
      );

      expect(series).toEqual([
        { effectiveOn: '2020-01-01', rate: 15.768556 },
      ]);
    });

    /**
     * The property the whole sync design rests on: the script, the cron and
     * the endpoint may all run any number of times a day, and a wrong value
     * is corrected rather than duplicated.
     */
    it('overwrites the same day rather than adding a row', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
      ]);
      await currencies.upsertRates([
        { code: CODE, rate: 20, effectiveOn: '2020-01-01' },
      ]);

      const rows = await dataSource.query(
        `SELECT rate::float8 AS rate FROM currency_rate
         WHERE "currencyId" = (SELECT id FROM currency WHERE code = $1)`,
        [CODE],
      ) as { rate: number }[];

      expect(rows).toEqual([{ rate: 20 }]);
    });

    it('collapses a batch that names the same day twice', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 30, effectiveOn: '2020-01-01' },
      ]);

      const rows = await dataSource.query(
        `SELECT rate::float8 AS rate FROM currency_rate
         WHERE "currencyId" = (SELECT id FROM currency WHERE code = $1)`,
        [CODE],
      ) as { rate: number }[];

      expect(rows).toEqual([{ rate: 30 }]);
    });

    /**
     * Rates hang off `currency.id`, so an unknown code cannot even be resolved
     * to a row to write — it fails with a readable message rather than a raw
     * constraint violation.
     */
    it('refuses a rate for a currency that does not exist', async () => {
      await expect(
        currencies.upsertRates([
          { code: 'ZZX', rate: 1, effectiveOn: '2020-01-01' },
        ]),
      ).rejects.toThrow(/Unknown currency code/i);
    });
  });

  describe('probeRates', () => {
    beforeEach(async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 20, effectiveOn: '2020-01-02' },
        { code: CODE, rate: 30, effectiveOn: '2020-01-03' },
      ]);
    });

    it('resolves a day it has an exact rate for', async () => {
      const [probe] = await currencies.probeRates([
        { code: CODE, day: '2020-01-02' },
      ]);

      expect(probe).toEqual({
        code: CODE,
        requestedOn: '2020-01-02',
        effectiveOn: '2020-01-02',
        rate: 20,
      });
    });

    /**
     * Past the last stored day the most recent earlier rate is used, and the
     * day it belongs to is reported — a caller must be able to say which rate
     * it applied rather than implying one that was never published.
     */
    it('falls back to the latest earlier day and says so', async () => {
      const [probe] = await currencies.probeRates([
        { code: CODE, day: '2020-06-01' },
      ]);

      expect(probe).toMatchObject({
        requestedOn: '2020-06-01',
        effectiveOn: '2020-01-03',
        rate: 30,
      });
    });

    it('answers null for a day before anything was published', async () => {
      const [probe] = await currencies.probeRates([
        { code: CODE, day: '1999-01-01' },
      ]);

      expect(probe).toEqual({
        code: CODE,
        requestedOn: '1999-01-01',
        effectiveOn: null,
        rate: null,
      });
    });

    it('resolves a whole batch in one call, misses included', async () => {
      const probes = await currencies.probeRates([
        { code: CODE, day: '2020-01-01' },
        { code: CODE, day: '2020-01-03' },
        { code: CODE, day: '1999-01-01' },
      ]);

      expect(probes).toHaveLength(3);
      expect(probes.filter((probe) => probe.rate !== null)).toHaveLength(2);
    });

    it('collapses duplicate pairs', async () => {
      const probes = await currencies.probeRates([
        { code: CODE, day: '2020-01-01' },
        { code: CODE, day: '2020-01-01' },
      ]);

      expect(probes).toHaveLength(1);
    });

    it('normalizes a lower-case code', async () => {
      const [probe] = await currencies.probeRates([
        { code: CODE.toLowerCase(), day: '2020-01-01' },
      ]);

      expect(probe?.rate).toBe(10);
    });
  });

  describe('rateGaps', () => {
    it('finds nothing in a series with a row for every day', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 20, effectiveOn: '2020-01-02' },
        { code: CODE, rate: 30, effectiveOn: '2020-01-03' },
      ]);

      const gaps = await currencies.rateGaps();

      expect(gaps.filter((gap) => gap.code === CODE)).toEqual([]);
    });

    /**
     * The backfill fails on this, because the source publishes every calendar
     * day: a hole means our copy lost days rather than the source having none.
     */
    it('names a missing run of days', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 30, effectiveOn: '2020-01-05' },
      ]);

      const gaps = await currencies.rateGaps();

      expect(gaps.filter((gap) => gap.code === CODE)).toEqual([
        { code: CODE, after: '2020-01-01', before: '2020-01-05', missing: 3 },
      ]);
    });

    /**
     * Currencies start in different years (USD in 1996, EUR in 1999), so the
     * check has to look inside each currency's own span rather than across a
     * shared calendar.
     */
    it('does not read a later-starting currency as a hole', async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 20, effectiveOn: '2020-01-02' },
      ]);

      const gaps = await currencies.rateGaps();

      expect(gaps.filter((gap) => gap.code === CODE)).toEqual([]);
    });
  });

  describe('findRateSeries and findLatestRates', () => {
    beforeEach(async () => {
      await currencies.upsertRates([
        { code: CODE, rate: 10, effectiveOn: '2020-01-01' },
        { code: CODE, rate: 20, effectiveOn: '2020-01-02' },
        { code: CODE, rate: 30, effectiveOn: '2020-01-03' },
      ]);
    });

    it('returns the range ascending, both ends included', async () => {
      const series = await currencies.findRateSeries(
        CODE,
        '2020-01-01',
        '2020-01-02',
      );

      expect(series.map((point) => point.effectiveOn)).toEqual([
        '2020-01-01',
        '2020-01-02',
      ]);
    });

    it('reports the newest day per currency', async () => {
      const latest = await currencies.findLatestRates();

      expect(latest.find((row) => row.code === CODE)).toEqual({
        code: CODE,
        effectiveOn: '2020-01-03',
        rate: 30,
      });
    });
  });
});
