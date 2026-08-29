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
 * the keyword pass contributes its links on every sync, so before the column an
 * LLM-written link lived exactly until the next scrape of that store. That
 * regression is reproduced end to end below, as is the stronger claim manual
 * curation makes — that once a person has set the tags, neither pass may add to
 * them or take them away.
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

  const curatedStamp = async (): Promise<Date | null> => {
    const rows = await dataSource.query(
      'SELECT "flavorsCuratedAt" FROM product WHERE id = $1',
      [productId],
    ) as { flavorsCuratedAt: Date | null }[];

    return rows[0].flavorsCuratedAt;
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
      factSources: {},
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

  it('takes over every source when a person sets the tags', async () => {
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
    await products.setLlmFlavors(productId, [sherryId]);

    await products.setManualFlavors(productId, [sherryId]);

    /**
     * The curated set is the whole truth: `peated` was not kept, so it is gone
     * rather than demoted, and what stays is owned by the person.
     */
    expect(await links()).toEqual([{ name: 'sherry', source: 'manual' }]);
    expect(await curatedStamp()).not.toBeNull();
  });

  it('marks a bottling curated even with no tags left', async () => {
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);

    await products.setManualFlavors(productId, []);

    expect(await links()).toEqual([]);
    expect(await curatedStamp()).not.toBeNull();
  });

  it('lets no later sync re-add a tag a person removed', async () => {
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);
    await products.setManualFlavors(productId, []);

    /**
     * The listing still spells out the keyword, so the next sync matches it
     * again — and this is the case the curation marker exists for: without it
     * the tag would be back, and the removal would have lasted until the next
     * sync of any store carrying the bottling.
     */
    await products.addScrapeFlavors([{ productId, flavorId: peatedId }]);

    expect(await links()).toEqual([]);
  });

  it('lets the LLM pass neither add to nor replace a curated set', async () => {
    await products.setManualFlavors(productId, [peatedId]);

    await products.setLlmFlavors(productId, [sherryId]);

    expect(await links()).toEqual([{ name: 'peated', source: 'manual' }]);

    /**
     * The stamp is still written: it is what keeps the model from being asked
     * about this bottling again, and the answer is dropped either way.
     */
    expect(await stamp()).not.toBeNull();
  });

  /**
   * The guard that keeps the peat invariant true between reconciliation runs.
   *
   * Without it the model would repossess a knowledge-base tag one product at a
   * time, on whichever sync happened to re-ask — and the breakage would be
   * silent, because the tag itself does not change, only who owns it. The
   * invariant is stated on the source column, so ownership *is* the fact.
   */
  it('never lets the LLM pass take over a knowledge-base link', async () => {
    await dataSource.query(
      `INSERT INTO product_flavor ("productId", "flavorId", source)
       VALUES ($1, $2, 'kb')`,
      [productId, peatedId],
    );

    await products.setLlmFlavors(productId, [peatedId, sherryId]);

    expect(await links()).toEqual([
      { name: 'peated', source: 'kb' },
      { name: 'sherry', source: 'llm' },
    ]);
  });
});
