import 'reflect-metadata';

/**
 * `CollectionService.create` carries `@Transactional()`, which — unmocked —
 * needs `initializeTransactionalContext()` plus a registered `DataSource`
 * (real infrastructure the integration suite provides, not a unit test).
 * Replacing the decorator with a no-op keeps the transaction boundary out of
 * this suite's concern: every collaborator it would wrap is mocked anyway,
 * so there is nothing here for a real transaction to coordinate.
 */
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (): void => undefined,
}));

import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreStoreProductService } from '~core/store-product';
import {
  CoreUserCollectionPurchaseService,
  CoreUserCollectionService,
} from '~core/user-collection';
import { BadRequestError, NotFoundError } from '~errors';
import type {
  CollectionPurchaseResolved,
  CollectionPurchaseRow,
  CollectionRow,
  CollectionRowResolved,
  ID,
  ReportCurrentRow,
} from '~types';

import { CollectionService } from '../src/domain/collection/collection.service';

const USER = 'user-1' as ID;
const PRODUCT_ID = 'product-1' as ID;
const COLLECTION_ID = 'row-1' as ID;
const PURCHASE_ID = 'purchase-1' as ID;
const STORE_ID = 'store-1' as ID;

/**
 * Builds a collection row as the repository's SQL projection returns it.
 *
 * @param over - Fields to override.
 * @returns A complete collection row.
 */
function makeRow(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: COLLECTION_ID,
    productId: PRODUCT_ID,
    rating: null,
    barcode: null,
    notes: null,
    nose: null,
    palate: null,
    finish: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    name: 'Ardbeg 10',
    nameOrig: 'Ardbeg 10 Years',
    age: 10,
    abv: 46,
    volumeMl: 700,
    brand: 'Ardbeg',
    distillery: 'Ardbeg',
    bottler: null,
    type: 'Single Malt',
    countryCode: 'GB',
    countryName: 'Велика Британія',
    countryIcon: '🇬🇧',
    region: 'islay',
    flavors: ['peated', 'smoky'],
    ...over,
  };
}

/**
 * Builds a purchase row as the repository's SQL projection returns it, the
 * store columns still flattened.
 *
 * @param over - Fields to override.
 * @returns A complete purchase row.
 */
function makePurchaseRow(
  over: Partial<CollectionPurchaseRow> = {},
): CollectionPurchaseRow {
  return {
    id: PURCHASE_ID,
    collectionId: COLLECTION_ID,
    purchasedOn: '2026-01-05',
    price: 1200,
    storeSlug: 'maudau',
    storeLabel: 'MauDau',
    storeColor: '#ff0000',
    storeName: null,
    storeProductId: 'offer-1' as ID,
    createdAt: new Date('2026-01-05T12:00:00.000Z'),
    ...over,
  };
}

/**
 * Builds one store's current-row offer of a bottling.
 *
 * @param over - Fields to override.
 * @returns A complete current row.
 */
function makeCurrentRow(
  over: Partial<ReportCurrentRow> = {},
): ReportCurrentRow {
  return {
    id: 'offer-1' as ID,
    productId: PRODUCT_ID,
    sku: 'sku-1',
    url: 'https://example.com/sku-1',
    name: 'Ardbeg 10',
    nameOrig: 'Ardbeg 10 Years',
    age: 10,
    abv: 46,
    volumeMl: 700,
    storeSlug: 'maudau',
    storeName: 'MauDau',
    brand: 'Ardbeg',
    type: 'Single Malt',
    countryCode: 'GB',
    countryName: 'Велика Британія',
    countryIcon: '🇬🇧',
    price: 1500,
    oldPrice: null,
    currency: 'UAH',
    inStock: true,
    promo: false,
    previousPrice: null,
    capturedDate: '2026-01-05',
    firstSeen: '2026-01-01',
    flavors: ['peated'],
    distillery: 'Ardbeg',
    region: 'islay',
    bottler: null,
    factSources: {},
    ...over,
  };
}

interface Mocks {
  service: CollectionService;
  collection: Record<string, jest.Mock>;
  purchases: Record<string, jest.Mock>;
  offers: Record<string, jest.Mock>;
  products: Record<string, jest.Mock>;
  stores: Record<string, jest.Mock>;
}

/**
 * Wires a `CollectionService` whose five collaborators are mocks, all
 * defaulted to a working happy path so a test only overrides what it
 * actually exercises.
 *
 * @returns The service plus every mock worth asserting on.
 */
function makeService(): Mocks {
  const collection = {
    findByUserId: jest.fn().mockResolvedValue([]),
    findByIdForUser: jest.fn().mockResolvedValue(makeRow()),
    findProductIdsByUserId: jest.fn().mockResolvedValue([]),
    findIdForUserOrThrow: jest.fn().mockResolvedValue(COLLECTION_ID),
    createForUser: jest.fn().mockResolvedValue(COLLECTION_ID),
    updateForUser: jest.fn().mockResolvedValue(undefined),
    deleteForUser: jest.fn().mockResolvedValue(undefined),
  };

  const purchases = {
    findByCollectionIds: jest.fn().mockResolvedValue([]),
    createForCollection: jest.fn().mockResolvedValue(PURCHASE_ID),
    updateForCollection: jest.fn().mockResolvedValue(undefined),
    deleteForCollection: jest.fn().mockResolvedValue(undefined),
  };

  const offers = {
    findCurrentRowsByProductIds: jest.fn().mockResolvedValue([]),
    findCurrentRowById: jest.fn().mockResolvedValue(
      makeCurrentRow({ productId: PRODUCT_ID }),
    ),
  };

  const products = {
    findExistingIds: jest.fn().mockResolvedValue(new Set([PRODUCT_ID])),
  };

  const stores = {
    findOne: jest.fn().mockResolvedValue({ id: STORE_ID }),
  };

  const service = new CollectionService(
    collection as unknown as CoreUserCollectionService,
    purchases as unknown as CoreUserCollectionPurchaseService,
    offers as unknown as CoreStoreProductService,
    products as unknown as CoreProductService,
    stores as unknown as CoreStoreService,
  );

  return { service, collection, purchases, offers, products, stores };
}

describe('CollectionService.getOwn', () => {
  it('loads purchases and offers in one bulk call each', async () => {
    const rowA = makeRow({ id: 'row-a' as ID, productId: 'product-a' as ID });
    const rowB = makeRow({ id: 'row-b' as ID, productId: 'product-b' as ID });
    const { service, collection, purchases, offers } = makeService();

    collection.findByUserId.mockResolvedValue([rowA, rowB]);
    purchases.findByCollectionIds.mockResolvedValue([
      makePurchaseRow({ id: 'purchase-a' as ID, collectionId: rowA.id }),
    ]);
    offers.findCurrentRowsByProductIds.mockResolvedValue([
      makeCurrentRow({ id: 'offer-a' as ID, productId: rowA.productId }),
    ]);

    await service.getOwn(USER);

    expect(purchases.findByCollectionIds).toHaveBeenCalledTimes(1);
    expect(purchases.findByCollectionIds)
      .toHaveBeenCalledWith([rowA.id, rowB.id]);
    expect(offers.findCurrentRowsByProductIds).toHaveBeenCalledTimes(1);
    expect(offers.findCurrentRowsByProductIds)
      .toHaveBeenCalledWith([rowA.productId, rowB.productId]);
  });

  it(
    'groups offers by product, cheapest first, with price rules applied',
    async () => {
      const row = makeRow({ id: 'row-1' as ID, productId: 'product-1' as ID });
      const pricier = makeCurrentRow({
        id: 'offer-pricier' as ID,
        productId: row.productId,
        storeSlug: 'goodwine',
        storeName: 'Goodwine',
        price: 1800,
        previousPrice: 1700,
      });
      const cheaper = makeCurrentRow({
        id: 'offer-cheaper' as ID,
        productId: row.productId,
        storeSlug: 'maudau',
        storeName: 'MauDau',
        price: 1500,
        previousPrice: 2000,
      });
      const { service, collection, offers } = makeService();

      collection.findByUserId.mockResolvedValue([row]);
      offers.findCurrentRowsByProductIds.mockResolvedValue([
        pricier,
        cheaper,
      ]);

      const [item] = await service.getOwn(USER);

      /**
       * `cheaper` (1500) leads `pricier` (1800): a previous price above the
       * current one (2000 -> 1500) becomes the reference and a 25% discount;
       * a previous price below it (1700 -> 1800) leaves both null.
       */
      expect(item.offers).toEqual([
        {
          id: 'offer-cheaper',
          url: cheaper.url,
          storeSlug: 'maudau',
          storeName: 'MauDau',
          price: 1500,
          oldPrice: null,
          referencePrice: 2000,
          discountPct: 25,
          currency: 'UAH',
          promo: false,
          capturedDate: cheaper.capturedDate,
        },
        {
          id: 'offer-pricier',
          url: pricier.url,
          storeSlug: 'goodwine',
          storeName: 'Goodwine',
          price: 1800,
          oldPrice: null,
          referencePrice: null,
          discountPct: null,
          currency: 'UAH',
          promo: false,
          capturedDate: pricier.capturedDate,
        },
      ]);
    },
  );

  it(
    'answers an empty offers array when no shop lists the bottling',
    async () => {
      const row = makeRow({
        id: 'row-1' as ID,
        productId: 'product-1' as ID,
      });
      const { service, collection, purchases, offers } = makeService();

      collection.findByUserId.mockResolvedValue([row]);
      purchases.findByCollectionIds.mockResolvedValue([
        makePurchaseRow({ collectionId: row.id }),
      ]);
      offers.findCurrentRowsByProductIds.mockResolvedValue([]);

      const [item] = await service.getOwn(USER);

      expect(item.offers).toEqual([]);
      expect(item.purchases).toHaveLength(1);
    },
  );

  it('answers an empty purchases array for a whisky only tasted', async () => {
    const row = makeRow({ id: 'row-1' as ID, productId: 'product-1' as ID });
    const { service, collection, purchases, offers } = makeService();

    collection.findByUserId.mockResolvedValue([row]);
    purchases.findByCollectionIds.mockResolvedValue([]);
    offers.findCurrentRowsByProductIds.mockResolvedValue([
      makeCurrentRow({ productId: row.productId }),
    ]);

    const [item] = await service.getOwn(USER);

    expect(item.purchases).toEqual([]);
    expect(item.offers).toHaveLength(1);
  });

  it('returns nothing and touches neither service when empty', async () => {
    const { service, purchases, offers } = makeService();

    const result = await service.getOwn(USER);

    expect(result).toEqual([]);
    expect(purchases.findByCollectionIds).not.toHaveBeenCalled();
    expect(offers.findCurrentRowsByProductIds).not.toHaveBeenCalled();
  });
});

describe('CollectionService.create', () => {
  describe('validation order', () => {
    it('rejects an unknown product first', async () => {
      const { service, products, collection } = makeService();

      products.findExistingIds.mockResolvedValue(new Set());

      const failure = service.create(USER, { productId: PRODUCT_ID });

      await expect(failure).rejects.toThrow(BadRequestError);
      await expect(failure).rejects.toMatchObject({
        message: 'Unknown product',
        data: { productId: PRODUCT_ID },
      });
      expect(collection.createForUser).not.toHaveBeenCalled();
    });

    it('rejects a storeProductId of a different product next', async () => {
      const { service, offers, stores, collection } = makeService();
      const otherProductId = 'product-other' as ID;

      offers.findCurrentRowById.mockResolvedValue(
        makeCurrentRow({ productId: otherProductId }),
      );

      const failure = service.create(USER, {
        productId: PRODUCT_ID,
        purchase: { storeProductId: 'offer-1' as ID },
      });

      await expect(failure).rejects.toThrow(BadRequestError);
      await expect(failure).rejects.toMatchObject({
        message: 'Store offer belongs to a different product',
        data: { storeProductId: 'offer-1', productId: otherProductId },
      });
      expect(stores.findOne).not.toHaveBeenCalled();
      expect(collection.createForUser).not.toHaveBeenCalled();
    });

    it('rejects a purchase naming both shops third', async () => {
      const { service, stores, collection } = makeService();

      const failure = service.create(USER, {
        productId: PRODUCT_ID,
        purchase: { storeSlug: 'maudau', storeName: 'Duty free' },
      });

      await expect(failure).rejects.toThrow(BadRequestError);
      await expect(failure).rejects.toMatchObject({
        message:
          'A purchase cannot name both a known store and a free-text shop',
      });
      expect(stores.findOne).not.toHaveBeenCalled();
      expect(collection.createForUser).not.toHaveBeenCalled();
    });

    it('rejects an unknown store slug last', async () => {
      const { service, stores, collection } = makeService();

      stores.findOne.mockResolvedValue(null);

      const failure = service.create(USER, {
        productId: PRODUCT_ID,
        purchase: { storeSlug: 'ghost-store' },
      });

      await expect(failure).rejects.toThrow(BadRequestError);
      await expect(failure).rejects.toMatchObject({
        message: 'Unknown store',
        data: { storeSlug: 'ghost-store' },
      });
      expect(collection.createForUser).not.toHaveBeenCalled();
    });

    it('lets the earliest failing check win over a later one', async () => {
      const { service, products, offers, stores, collection } = makeService();

      products.findExistingIds.mockResolvedValue(new Set());

      const failure = service.create(USER, {
        productId: PRODUCT_ID,
        purchase: { storeSlug: 'maudau', storeName: 'Duty free' },
      });

      await expect(failure).rejects.toMatchObject({
        message: 'Unknown product',
      });
      expect(offers.findCurrentRowById).not.toHaveBeenCalled();
      expect(stores.findOne).not.toHaveBeenCalled();
      expect(collection.createForUser).not.toHaveBeenCalled();
    });
  });

  describe('purchase defaulting', () => {
    it(
      'fills price and store from the named offer when neither is sent',
      async () => {
        const { service, offers, stores, purchases } = makeService();

        offers.findCurrentRowById.mockResolvedValue(
          makeCurrentRow({
            productId: PRODUCT_ID,
            storeSlug: 'maudau',
            price: 1200,
          }),
        );
        stores.findOne.mockResolvedValue({ id: 'store-maudau' as ID });

        await service.create(USER, {
          productId: PRODUCT_ID,
          purchase: { storeProductId: 'offer-1' as ID },
        });

        expect(stores.findOne).toHaveBeenCalledWith({ slug: 'maudau' });

        const [, resolved] = purchases.createForCollection.mock.calls[0] as [
          ID,
          CollectionPurchaseResolved,
        ];

        expect(resolved.price).toBe(1200);
        expect(resolved.storeId).toBe('store-maudau');
      },
    );

    it('leaves a client-sent price and store untouched', async () => {
      const { service, offers, stores, purchases } = makeService();

      offers.findCurrentRowById.mockResolvedValue(
        makeCurrentRow({
          productId: PRODUCT_ID,
          storeSlug: 'maudau',
          price: 1200,
        }),
      );
      stores.findOne.mockResolvedValue({ id: 'store-rozetka' as ID });

      await service.create(USER, {
        productId: PRODUCT_ID,
        purchase: {
          storeProductId: 'offer-1' as ID,
          price: 999,
          storeSlug: 'rozetka',
        },
      });

      expect(stores.findOne).toHaveBeenCalledWith({ slug: 'rozetka' });
      expect(stores.findOne).not.toHaveBeenCalledWith({ slug: 'maudau' });

      const [, resolved] = purchases.createForCollection.mock.calls[0] as [
        ID,
        CollectionPurchaseResolved,
      ];

      expect(resolved.price).toBe(999);
      expect(resolved.storeId).toBe('store-rozetka');
    });
  });

  it('writes no purchase row when the request names none', async () => {
    const { service, purchases, collection } = makeService();

    await service.create(USER, { productId: PRODUCT_ID });

    expect(purchases.createForCollection).not.toHaveBeenCalled();
    expect(collection.createForUser)
      .toHaveBeenCalledWith(USER, PRODUCT_ID, {});
  });
});

describe('CollectionService.update', () => {
  it('maps the dto onto the resolved patch', async () => {
    const { service, collection } = makeService();

    await service.update(USER, COLLECTION_ID, {
      barcode: '',
      clearRating: true,
      nose: 'Smoky nose',
      palate: '',
      finish: 'Long and warm',
    });

    const [, , patch] = collection.updateForUser.mock.calls[0] as [
      ID,
      ID,
      CollectionRowResolved,
    ];

    expect(patch).toEqual({
      rating: null,
      barcode: null,
      nose: 'Smoky nose',
      palate: null,
      finish: 'Long and warm',
    });

    /**
     * `notes` was never sent, so it must be absent from the patch entirely —
     * not merely equal to `null` or `undefined`.
     */
    expect(patch).not.toHaveProperty('notes');
  });
});

describe('CollectionService purchase mutations', () => {
  it('propagates the addPurchase ownership failure', async () => {
    const { service, collection, purchases } = makeService();

    collection.findIdForUserOrThrow.mockRejectedValueOnce(
      new NotFoundError('Collection item not found'),
    );

    await expect(
      service.addPurchase(USER, COLLECTION_ID, { storeSlug: 'maudau' }),
    ).rejects.toThrow(NotFoundError);
    expect(purchases.createForCollection).not.toHaveBeenCalled();
  });

  it('checks ownership before writing a new purchase', async () => {
    const { service, collection, purchases } = makeService();
    const order: string[] = [];

    collection.findIdForUserOrThrow.mockImplementationOnce(async () => {
      order.push('ownership');

      return COLLECTION_ID;
    });
    purchases.createForCollection.mockImplementationOnce(async () => {
      order.push('write');

      return PURCHASE_ID;
    });

    await service.addPurchase(USER, COLLECTION_ID, { storeSlug: 'maudau' });

    expect(order).toEqual(['ownership', 'write']);
  });

  it('propagates the updatePurchase ownership failure', async () => {
    const { service, collection, purchases } = makeService();

    collection.findIdForUserOrThrow.mockRejectedValueOnce(
      new NotFoundError('Collection item not found'),
    );

    await expect(
      service.updatePurchase(USER, COLLECTION_ID, PURCHASE_ID, {
        price: 500,
      }),
    ).rejects.toThrow(NotFoundError);
    expect(purchases.updateForCollection).not.toHaveBeenCalled();
  });

  it('checks ownership before patching a purchase', async () => {
    const { service, collection, purchases } = makeService();
    const order: string[] = [];

    collection.findIdForUserOrThrow.mockImplementationOnce(async () => {
      order.push('ownership');

      return COLLECTION_ID;
    });
    purchases.updateForCollection.mockImplementationOnce(async () => {
      order.push('write');
    });

    await service.updatePurchase(USER, COLLECTION_ID, PURCHASE_ID, {
      price: 500,
    });

    expect(order).toEqual(['ownership', 'write']);
  });

  it('propagates the removePurchase ownership failure', async () => {
    const { service, collection, purchases } = makeService();

    collection.findIdForUserOrThrow.mockRejectedValueOnce(
      new NotFoundError('Collection item not found'),
    );

    await expect(
      service.removePurchase(USER, COLLECTION_ID, PURCHASE_ID),
    ).rejects.toThrow(NotFoundError);
    expect(purchases.deleteForCollection).not.toHaveBeenCalled();
  });

  it('checks ownership before deleting a purchase', async () => {
    const { service, collection, purchases } = makeService();
    const order: string[] = [];

    collection.findIdForUserOrThrow.mockImplementationOnce(async () => {
      order.push('ownership');

      return COLLECTION_ID;
    });
    purchases.deleteForCollection.mockImplementationOnce(async () => {
      order.push('write');
    });

    await service.removePurchase(USER, COLLECTION_ID, PURCHASE_ID);

    expect(order).toEqual(['ownership', 'write']);
  });
});
