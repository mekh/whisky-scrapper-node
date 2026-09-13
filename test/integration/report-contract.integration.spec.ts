import { TestingModule } from '@nestjs/testing';
import { getMetadataStorage } from 'class-validator';
import { DataSource } from 'typeorm';

import { CorePreferenceService } from '~core/preference';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type { ID, ReportOptions } from '~types';

import { ReportService } from '../../src/domain/report/report.service';
import {
  PriceHistoryType,
  ReportGroupType,
  ReportOfferType,
  ReportRowType,
} from '../../src/domain/report/types';
import { passthroughCache } from '../cache-stub';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * `ReportController` is opted out of the outgoing DTO pipeline, so what the
 * service returns is the wire contract verbatim. These assertions are what
 * the pipeline used to make on every request: a column added to the report
 * SQL was stripped in silence and would now reach the client.
 */
const USER_ID = '0198d1f6-0000-7000-8000-0000000000c1' as ID;

const STAMP = Date.now();

const SLUG = `__it_ctr_${STAMP}`;

const TOKEN = `itctr${STAMP}`;

const DAY = '2026-07-25';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

/**
 * The properties a response type declares to class-validator, which is the
 * set `whitelist: true` used to keep and delete everything else against.
 *
 * @param cls - The response type to read.
 * @returns Its declared property names, sorted and deduplicated.
 */
function declaredFields(cls: object): string[] {
  const metadatas = getMetadataStorage().getTargetValidationMetadatas(
    cls as never,
    (cls as { name: string }).name,
    true,
    false,
  );

  return [...new Set(metadatas.map((meta) => meta.propertyName))].sort();
}

/**
 * An object's own keys in the same comparable form.
 *
 * @param value - The object to read.
 * @returns Its keys, sorted.
 */
function actualFields(value: object): string[] {
  return Object.keys(value).sort();
}

describe('report wire contract over the live query (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: ReportService;
  let storeId: ID;
  let offerId: ID;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);

    const products = moduleRef.get(CoreProductService, { strict: false });
    const offers = moduleRef.get(CoreStoreProductService, { strict: false });
    const snapshots = moduleRef.get(
      CorePriceSnapshotService,
      { strict: false },
    );

    service = new ReportService(
      offers,
      snapshots,
      moduleRef.get(CorePreferenceService, { strict: false }),
      passthroughCache(),
    );

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Contract', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = stores[0].id;

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [storeId],
    );

    const { ids } = await products.findOrCreateByMatchKeys([
      {
        factSources: {},
        matchKey: `${TOKEN}-sample`,
        name: `Sample ${TOKEN}`,
        brandOrig: null,
        typeId: null,
        countryId: null,
        age: 12,
        abv: null,
        volumeMl: 700,
      },
    ]);

    const productId = [...ids.values()][0];

    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku: `sku-${TOKEN}`,
      url: `https://example.test/${TOKEN}`,
      nameOrig: `Віскі Sample ${TOKEN} 0.7л`,
      seenOn: DAY,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    offerId = offer.id;

    await snapshots.upsertForDate(offer.id, DAY, {
      price: 1000,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = $1',
        [storeId],
      );
      await dataSource.query('DELETE FROM product WHERE "matchKey" LIKE $1', [
        `${TOKEN}%`,
      ]);
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('answers a group with exactly the fields its type declares', async () => {
    const page = await service.report(
      ReportKind.CATALOG,
      { name: TOKEN },
      OPTIONS,
      { userId: USER_ID },
    );

    expect(page.data).toHaveLength(1);
    expect(actualFields(page.data[0])).toEqual(
      declaredFields(ReportGroupType),
    );
  });

  it('answers an offer with exactly the fields its type declares', async () => {
    const page = await service.report(
      ReportKind.CATALOG,
      { name: TOKEN },
      OPTIONS,
      { userId: USER_ID },
    );

    expect(page.data[0].offers).toHaveLength(1);
    expect(actualFields(page.data[0].offers[0])).toEqual(
      declaredFields(ReportOfferType),
    );
  });

  it('answers a page envelope with exactly its declared fields', async () => {
    const page = await service.report(
      ReportKind.CATALOG,
      { name: TOKEN },
      OPTIONS,
      { userId: USER_ID },
    );

    expect(actualFields(page)).toEqual(['data', 'limit', 'offset', 'total']);
  });

  it('answers a history product with its declared fields', async () => {
    const history = await service.history(offerId);

    expect(actualFields(history)).toEqual(declaredFields(PriceHistoryType));
    expect(actualFields(history.product)).toEqual(
      declaredFields(ReportRowType),
    );
  });

  it('answers a history point with its declared fields', async () => {
    const history = await service.history(offerId);

    expect(history.series.length).toBeGreaterThan(0);
    expect(actualFields(history.series[0])).toEqual(['date', 'price']);
  });
});
