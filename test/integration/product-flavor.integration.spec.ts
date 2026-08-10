import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const SLUG = `__it_flavor_${Date.now()}`;
const DAY = '2026-08-10';

/**
 * The flavor-link ownership rules, against a real database.
 *
 * The behaviour under test is the whole reason `product_flavor.source` exists:
 * `setFlavors` re-derives the keyword pass's links on every sync, so before the
 * column an LLM-written link lived exactly until the next scrape of that store.
 * The last case here is that regression, reproduced end to end.
 */
describe('product flavor links (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let flavors: CoreFlavorService;
  let storeId: ID;
  let productId: ID;
  let peatedId: ID;
  let sherryId: ID;

  const links = async (): Promise<{ name: string; source: string }[]> => {
    return dataSource.query(
      `SELECT f.name, pf.source
       FROM product_flavor pf
       JOIN flavor f ON f.id = pf."flavorId"
       WHERE pf."productId" = $1
       ORDER BY f.name`,
      [productId],
    ) as Promise<{ name: string; source: string }[]>;
  };

  const stamp = async (): Promise<Date | null> => {
    const rows = await dataSource.query(
      'SELECT "lastLlmFlavorAt" FROM product WHERE id = $1',
      [productId],
    ) as { lastLlmFlavorAt: Date | null }[];

    return rows[0].lastLlmFlavorAt;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    flavors = moduleRef.get(CoreFlavorService, { strict: false });

    const storeRows = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Flavor Store', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = storeRows[0].id;

    const resolved = await flavors.resolveByName(['peated', 'sherry']);

    peatedId = resolved.get('peated') as ID;
    sherryId = resolved.get('sherry') as ID;
  });

  beforeEach(async () => {
    const result = await products.upsertFromScrape({
      storeId,
      sku: 'sku-1',
      url: 'https://example.test/p1',
      nameOrig: 'Віскі Sample 0.7л',
      name: 'Sample',
      brandId: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: null,
      volumeMl: null,
      seenOn: DAY,
    });

    productId = result.id;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM product WHERE "storeId" = $1', [
      storeId,
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('marks keyword-pass links as scrape-sourced', async () => {
    await products.setFlavors(productId, [peatedId]);

    expect(await links()).toEqual([{ name: 'peated', source: 'scrape' }]);
    expect(await stamp()).toBeNull();
  });

  it('stamps the product even when the LLM recognized nothing', async () => {
    await products.setLlmFlavors(productId, []);

    expect(await links()).toEqual([]);
    expect(await stamp()).not.toBeNull();
  });

  it('takes over a tag the keyword pass had already linked', async () => {
    await products.setFlavors(productId, [peatedId]);
    await products.setLlmFlavors(productId, [peatedId]);

    expect(await links()).toEqual([{ name: 'peated', source: 'llm' }]);
  });

  it(
    'keeps LLM links when a later sync re-derives the keyword ones',
    async () => {
      await products.setFlavors(productId, [peatedId]);
      await products.setLlmFlavors(productId, [sherryId]);

      /**
       * The next sync no longer matches `peated` in the listing — before the
       * `source` column this call wiped both links.
       */
      await products.setFlavors(productId, []);

      expect(await links()).toEqual([{ name: 'sherry', source: 'llm' }]);
      expect(await stamp()).not.toBeNull();
    },
  );

  it(
    'replaces the previous LLM answer without touching scrape links',
    async () => {
      await products.setFlavors(productId, [peatedId]);
      await products.setLlmFlavors(productId, [sherryId]);
      await products.setLlmFlavors(productId, []);

      expect(await links()).toEqual([{ name: 'peated', source: 'scrape' }]);
    },
  );
});
