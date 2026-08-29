import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type { ID, ReportFilter, ReportGroup, ReportOptions } from '~types';

import { ReportService } from '../../src/domain/report/report.service';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * The report's per-user predicates are anti-joins against tables this suite
 * never writes, so any uuid reads as "a user with no preferences" — no `user`
 * row is needed.
 */
const USER_ID = '0198d1f6-0000-7000-8000-0000000000b1' as ID;

const STAMP = Date.now();

const SLUG_A = `__it_grp_a_${STAMP}`;

const SLUG_B = `__it_grp_b_${STAMP}`;

/**
 * A token no catalogue row can contain, so every assertion below scopes itself
 * to the seeded rows through the report's own name filter instead of scanning
 * whatever the local database happens to hold.
 */
const TOKEN = `itgrp${STAMP}`;

/**
 * A second such token, carried by the one seeded bottling that states an age.
 * It is kept out of `TOKEN` so the assertions on the catalogue's shape above
 * count the same rows they always did.
 */
const AGED = `itage${STAMP}`;

const DAY = '2026-07-25';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

describe('report grouping over the live query (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let snapshots: CorePriceSnapshotService;
  let service: ReportService;
  let storeA: ID;
  let storeB: ID;
  let sampleId: ID;
  let agedId: ID;

  /**
   * Runs the catalog report with the seeded rows in scope.
   *
   * @param filter - Extra filter fields on top of the name scoping.
   * @returns The report groups.
   */
  const catalog = async (
    filter: Partial<ReportFilter> = {},
  ): Promise<ReportGroup[]> => {
    const page = await service.report(
      ReportKind.CATALOG,
      { userId: USER_ID, name: TOKEN, ...filter },
      OPTIONS,
    );

    return page.data;
  };

  /**
   * Creates a store with a config row.
   *
   * @param slug - The store slug.
   * @param name - The store display name.
   * @returns The new store id.
   */
  const makeStore = async (slug: string, name: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, $2, 'https://example.test', true)
       RETURNING id`,
      [slug, name],
    ) as { id: ID }[];

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [rows[0].id],
    );

    return rows[0].id;
  };

  /**
   * Creates a bottling.
   *
   * @param key - Suffix of its match key.
   * @param name - The canonical product name.
   * @param age - Its age statement in years, or null when it has none.
   * @returns The new product id.
   */
  const makeBottling = async (
    key: string,
    name: string,
    age: number | null = null,
  ): Promise<ID> => {
    const { ids } = await products.findOrCreateByMatchKeys([
      {
        factSources: {},
        matchKey: `${TOKEN}-${key}`,
        name,
        brandId: null,
        typeId: null,
        countryId: null,
        age,
        abv: null,
        volumeMl: 700,
      },
    ]);

    return [...ids.values()][0];
  };

  /**
   * Creates one store's offer of a bottling and gives it a price.
   *
   * @param storeId - The store carrying it.
   * @param productId - The bottling offered.
   * @param nameOrig - The raw name as that store spells it.
   * @param price - The offer's current price.
   * @returns Resolves once the offer and its snapshot exist.
   */
  const makeOffer = async (
    storeId: ID,
    productId: ID,
    nameOrig: string,
    price: number,
  ): Promise<void> => {
    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku: `sku-${nameOrig.length}-${price}`,
      url: `https://example.test/${price}`,
      nameOrig,
      seenOn: DAY,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    await snapshots.upsertForDate(offer.id, DAY, {
      price,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });

    /**
     * The report service is instantiated directly, exactly as the unit spec
     * does: the integration module exposes the core graph, and the controller's
     * global guards are not what these assertions are about.
     */
    service = new ReportService(offers, snapshots);

    storeA = await makeStore(SLUG_A, 'IT Group A');
    storeB = await makeStore(SLUG_B, 'IT Group B');

    sampleId = await makeBottling('sample', `Sample ${TOKEN} 0.7l`);

    const otherId = await makeBottling('other', `Other ${TOKEN} 0.7l`);

    /**
     * A 12-year-old whose age appears in neither name, which is the shape the
     * plain substring search cannot reach.
     */
    agedId = await makeBottling('aged', `Aged ${AGED}`, 12);

    await makeOffer(storeA, agedId, `Віскі Aged ${AGED} 0.7л`, 1500);

    await makeOffer(storeA, sampleId, `Віскі Sample ${TOKEN} 0.7л`, 1000);
    await makeOffer(
      storeB,
      sampleId,
      `Віскі Sample ${TOKEN} 0.7л в коробці`,
      1200,
    );
    await makeOffer(storeA, otherId, `Віскі Other ${TOKEN} 0.7л`, 900);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = ANY($1)',
        [[storeA, storeB]],
      );
      await dataSource.query('DELETE FROM product WHERE "matchKey" LIKE $1', [
        `${TOKEN}%`,
      ]);
      await dataSource.query('DELETE FROM store WHERE id = ANY($1)', [
        [storeA, storeB],
      ]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('groups two stores of one bottling, cheapest first', async () => {
    const data = await catalog();
    const sample = data.find((group) => group.productId === sampleId);

    expect(sample?.offers).toHaveLength(2);
    expect(sample?.offers.map((offer) => offer.price)).toEqual([1000, 1200]);
    expect(sample?.id).toBe(sample?.offers[0].id);
    expect(sample?.storeName).toBe('IT Group A');
  });

  it('counts bottlings, not offers', async () => {
    const page = await service.report(
      ReportKind.CATALOG,
      { userId: USER_ID, name: TOKEN },
      OPTIONS,
    );

    expect(page.total).toBe(2);
  });

  it('restricts the offers to the requested store', async () => {
    const data = await catalog({ stores: [SLUG_B] });
    const sample = data.find((group) => group.productId === sampleId);

    expect(sample?.offers).toHaveLength(1);
    expect(sample?.offers[0].storeSlug).toBe(SLUG_B);
    expect(sample?.price).toBe(1200);
  });

  it('moves the primary when a price filter cuts the cheapest', async () => {
    const data = await catalog({ minPrice: 1100 });
    const sample = data.find((group) => group.productId === sampleId);

    expect(sample?.offers).toHaveLength(1);
    expect(sample?.price).toBe(1200);
  });

  it('keeps only the offers a raw-name search matched', async () => {
    /**
     * "в коробці" survives in one store's raw name alone, so the group is the
     * matching offer only — the same rule every other offer-level filter
     * follows.
     */
    const data = await catalog({ name: `${TOKEN} 0.7л в коробці` });

    expect(data).toHaveLength(1);
    expect(data[0].offers).toHaveLength(1);
    expect(data[0].offers[0].storeSlug).toBe(SLUG_B);
  });

  it('reads a trailing number as an age the name misses', async () => {
    /**
     * Neither the canonical nor the raw name holds a `12`, so the substring
     * pass matches nothing: the row comes back only because the term is split
     * into a name part and an age.
     */
    const data = await catalog({ name: `${AGED} 12` });

    expect(data).toHaveLength(1);
    expect(data[0].productId).toBe(agedId);
  });

  it('matches nothing when the age of the term is another one', async () => {
    const data = await catalog({ name: `${AGED} 15` });

    expect(data).toHaveLength(0);
  });

  it('keeps matching the name alone when the term has no age', async () => {
    const data = await catalog({ name: AGED });

    expect(data).toHaveLength(1);
    expect(data[0].productId).toBe(agedId);
  });

  it('applies a product-level filter to the whole group', async () => {
    const data = await catalog({ types: ['unknown'] });

    expect(data).toHaveLength(2);

    const sample = data.find((group) => group.productId === sampleId);

    expect(sample?.offers).toHaveLength(2);
  });
});
