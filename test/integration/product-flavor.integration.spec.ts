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
    productId = await products.createUnmatched({
      matchKey: null,
      name: 'Sample',
      brandId: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: null,
      volumeMl: null,
    });
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM store_product WHERE "storeId" = $1', [
      storeId,
    ]);
    await dataSource.query('DELETE FROM product WHERE id = $1', [productId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('marks keyword-pass links as scrape-sourced', async () => {
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);

    expect(await links()).toEqual([{ name: 'peated', source: 'scrape' }]);
    expect(await stamp()).toBeNull();
  });

  it('stamps the product even when the LLM recognized nothing', async () => {
    await products.setLlmFlavors(productId, []);

    expect(await links()).toEqual([]);
    expect(await stamp()).not.toBeNull();
  });

  it('takes over a tag the keyword pass had already linked', async () => {
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
    await products.setLlmFlavors(productId, [peatedId]);

    expect(await links()).toEqual([{ name: 'peated', source: 'llm' }]);
  });

  it("never lets a sync erase another store's finding", async () => {
    /**
     * The tags now hang off a bottling several stores share. A store whose
     * listing does not happen to mention peat has learned nothing about peat,
     * so its sync must not be able to remove what another store's listing
     * stated — the keyword links only ever accumulate.
     */
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
    await products.addScrapeFlavors([{ productId, flavorId: sherryId }]);

    expect(await links()).toEqual([
      { name: 'peated', source: 'scrape' },
      { name: 'sherry', source: 'scrape' },
    ]);
  });

  it('does not demote a tag the LLM already owns', async () => {
    await products.setLlmFlavors(productId, [peatedId]);
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);

    expect(await links()).toEqual([{ name: 'peated', source: 'llm' }]);
  });

  it(
    'keeps LLM links when a later sync re-derives the keyword ones',
    async () => {
      await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
      await products.setLlmFlavors(productId, [sherryId]);

      /**
       * The next sync no longer matches `peated` in the listing. It adds
       * nothing and removes nothing, so both links stand.
       */
      await products.addScrapeFlavors([]);

      expect(await links()).toEqual([
        { name: 'peated', source: 'scrape' },
        { name: 'sherry', source: 'llm' },
      ]);
      expect(await stamp()).not.toBeNull();
    },
  );

  it(
    'replaces the previous LLM answer without touching scrape links',
    async () => {
      await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
      await products.setLlmFlavors(productId, [sherryId]);
      await products.setLlmFlavors(productId, []);

      expect(await links()).toEqual([{ name: 'peated', source: 'scrape' }]);
    },
  );
});
