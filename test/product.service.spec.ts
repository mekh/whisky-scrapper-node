import 'reflect-metadata';

/**
 * `ProductService.update` and `.relink` carry `@Transactional()`, which —
 * unmocked — needs `initializeTransactionalContext()` plus a registered
 * `DataSource`, real infrastructure the integration suite provides. Every
 * collaborator the decorator would wrap is mocked here, so there is nothing
 * for a transaction to coordinate and the decorator becomes a no-op.
 */
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (): void => undefined,
}));

import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { BadRequestError, NotFoundError } from '~errors';
import type { ID, ProductUpdateInput } from '~types';

import { CoreTypeService } from '../src/core/type';
import { ProductService } from '../src/domain/product/product.service';

const OFFER_ID = 'offer-1' as ID;
const PRODUCT_ID = 'product-1' as ID;

const TWIN_ID = 'product-2' as ID;
const OTHER_TWIN_ID = 'product-3' as ID;

interface Mocks {
  service: ProductService;
  products: {
    search: jest.Mock;
    setManualFlavors: jest.Mock;
    updateByIdOrThrow: jest.Mock;
    findIdentityTwins: jest.Mock;
    mergeInto: jest.Mock;
    findByIdOrThrow: jest.Mock;
    findById: jest.Mock;
    createUnmatched: jest.Mock;
    deleteIfUnreferenced: jest.Mock;
  };
  offers: {
    findOfferRefById: jest.Mock;
    findById: jest.Mock;
    relink: jest.Mock;
  };
  flavors: { findIdsByName: jest.Mock };
}

/**
 * Wires a `ProductService` whose collaborators are mocks: the offer resolves to
 * one bottling, the column patch succeeds, the bottling has no identity twins,
 * and the flavor lookup answers with the given name → id pairs (a name missing
 * from the map is an unknown flavor).
 *
 * @param known - Flavor names the reference table is to contain.
 * @returns The service plus the mocks worth asserting on.
 */
function makeService(known: Map<string, ID> = new Map()): Mocks {
  const products = {
    search: jest.fn().mockResolvedValue([]),
    updateByIdOrThrow: jest.fn().mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Sample',
      volumeMl: 700,
      age: 12,
    }),
    setManualFlavors: jest.fn().mockResolvedValue(undefined),
    findIdentityTwins: jest.fn().mockResolvedValue([]),
    mergeInto: jest.fn().mockResolvedValue(undefined),
    findByIdOrThrow: jest.fn().mockResolvedValue({
      id: TWIN_ID,
      name: 'Sample Twin',
    }),
    findById: jest.fn().mockResolvedValue(undefined),
    createUnmatched: jest.fn().mockResolvedValue('product-new'),
    deleteIfUnreferenced: jest.fn().mockResolvedValue(true),
  };

  const offers = {
    findOfferRefById: jest.fn().mockResolvedValue({
      id: OFFER_ID,
      productId: PRODUCT_ID,
      nameOrig: 'Віскі Sample 0,7л',
    }),
    findById: jest.fn().mockResolvedValue({
      id: OFFER_ID,
      productId: PRODUCT_ID,
      nameOrig: 'Віскі Sample 0,7л',
    }),
    relink: jest.fn().mockResolvedValue(PRODUCT_ID),
  };

  const flavors = {
    findIdsByName: jest.fn().mockResolvedValue(known),
  };

  const service = new ProductService(
    products as unknown as CoreProductService,
    offers as unknown as CoreStoreProductService,
    { findOne: jest.fn() } as unknown as CoreCountryService,
    { findOne: jest.fn() } as unknown as CoreTypeService,
    flavors as unknown as CoreFlavorService,
  );

  return { service, products, offers, flavors };
}

/**
 * Applies an edit that carries nothing but the id and the given fields.
 *
 * @param service - The service under test.
 * @param input - Fields to send alongside the id.
 * @returns Resolves once the edit has been applied.
 */
async function update(
  service: ProductService,
  input: Omit<ProductUpdateInput, 'id'>,
): Promise<void> {
  await service.update({ id: OFFER_ID, ...input });
}

describe('ProductService.search', () => {
  it('passes the term through with the requested limit', async () => {
    const { service, products } = makeService();

    await service.search({ q: 'glen', limit: 5 });

    expect(products.search).toHaveBeenCalledWith('glen', 5);
  });

  it('applies the default limit when the request names none', async () => {
    /**
     * The default lives in the domain service, not the controller — this is
     * the test that keeps it from silently moving.
     */
    const { service, products } = makeService();

    await service.search({ q: 'glen' });

    expect(products.search).toHaveBeenCalledWith('glen', 10);
  });
});

describe('ProductService.update flavors', () => {
  it("stores the resolved ids as the bottling's curated set", async () => {
    const { service, products, flavors } = makeService(
      new Map([['peated', 'flavor-1' as ID], ['sherry', 'flavor-2' as ID]]),
    );

    await update(service, { flavors: ['peated', 'sherry'] });

    expect(flavors.findIdsByName).toHaveBeenCalledWith(['peated', 'sherry']);
    expect(products.setManualFlavors).toHaveBeenCalledWith(PRODUCT_ID, [
      'flavor-1',
      'flavor-2',
    ]);
  });

  it('curates an empty set as "this whisky has no tags"', async () => {
    const { service, products } = makeService();

    await update(service, { flavors: [] });

    expect(products.setManualFlavors).toHaveBeenCalledWith(PRODUCT_ID, []);
  });

  it('leaves the tags alone when the field is absent', async () => {
    const { service, products } = makeService();

    await update(service, { name: 'Renamed' });

    expect(products.setManualFlavors).not.toHaveBeenCalled();
  });

  it('rejects a name the reference table does not hold', async () => {
    /**
     * The client picks from the `/meta` list, so an unknown name is a bad
     * request rather than a new flavor to coin — coining would let a typo into
     * the table every other product's filter reads from.
     */
    const { service, products } = makeService(
      new Map([['peated', 'flavor-1' as ID]]),
    );

    await expect(update(service, { flavors: ['peated', 'nope'] }))
      .rejects.toThrow(BadRequestError);

    expect(products.setManualFlavors).not.toHaveBeenCalled();
  });
});

describe('ProductService.update identity merge', () => {
  it('leaves a bottling alone when nothing shares its identity', async () => {
    const { service, products } = makeService();

    const result = await service.update({ id: OFFER_ID, name: 'Sample' });

    expect(products.findIdentityTwins).toHaveBeenCalledWith(
      'Sample',
      700,
      12,
      PRODUCT_ID,
    );
    expect(products.mergeInto).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: OFFER_ID,
      productId: PRODUCT_ID,
      name: 'Sample',
      nameOrig: 'Віскі Sample 0,7л',
      merged: false,
      created: false,
    });
  });

  it('folds the edited bottling into its most-listed twin', async () => {
    /**
     * The twin list comes back most-listed first, so the head is the
     * survivor: the edited row is merged into it, and the response names the
     * survivor rather than the row the client knew.
     */
    const { service, products } = makeService();

    products.findIdentityTwins.mockResolvedValue([TWIN_ID]);

    const result = await service.update({ id: OFFER_ID, name: 'Sample Twin' });

    expect(products.mergeInto).toHaveBeenCalledTimes(1);
    expect(products.mergeInto).toHaveBeenCalledWith(PRODUCT_ID, TWIN_ID);
    expect(products.findByIdOrThrow).toHaveBeenCalledWith(TWIN_ID);
    expect(result.productId).toBe(TWIN_ID);
    expect(result.merged).toBe(true);
    expect(result.name).toBe('Sample Twin');
    expect(result.id).toBe(OFFER_ID);
  });

  it('folds every further twin into the same survivor', async () => {
    const { service, products } = makeService();

    products.findIdentityTwins.mockResolvedValue([TWIN_ID, OTHER_TWIN_ID]);

    await service.update({ id: OFFER_ID, age: 12 });

    expect(products.mergeInto.mock.calls).toEqual([
      [PRODUCT_ID, TWIN_ID],
      [OTHER_TWIN_ID, TWIN_ID],
    ]);
  });

  it('checks for twins even when no identity field was edited', async () => {
    /**
     * An older duplicate is folded away the first time either row is touched,
     * whichever field the edit carried.
     */
    const { service, products } = makeService();

    await service.update({ id: OFFER_ID, abv: 43 });

    expect(products.findIdentityTwins).toHaveBeenCalledTimes(1);
  });

  it('writes the flavors before the merge so they ride along', async () => {
    const { service, products } = makeService(
      new Map([['peated', 'flavor-1' as ID]]),
    );

    products.findIdentityTwins.mockResolvedValue([TWIN_ID]);

    await service.update({ id: OFFER_ID, flavors: ['peated'] });

    const flavorsAt = products.setManualFlavors.mock.invocationCallOrder[0];
    const mergeAt = products.mergeInto.mock.invocationCallOrder[0];

    expect(products.setManualFlavors).toHaveBeenCalledWith(PRODUCT_ID, [
      'flavor-1',
    ]);
    expect(flavorsAt).toBeLessThan(mergeAt);
  });
});

describe('ProductService.relink', () => {
  it('refuses an id that names no offer', async () => {
    const { service, offers } = makeService();

    offers.findById.mockResolvedValue(undefined);

    await expect(
      service.relink({ id: OFFER_ID, productId: TWIN_ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('moves the offer onto the bottling named by id', async () => {
    const { service, products, offers } = makeService();

    products.findById.mockResolvedValue({ id: TWIN_ID, name: 'Target' });

    const result = await service.relink({ id: OFFER_ID, productId: TWIN_ID });

    expect(products.findById).toHaveBeenCalledWith(TWIN_ID);
    expect(offers.relink).toHaveBeenCalledWith(OFFER_ID, TWIN_ID);
    expect(products.findIdentityTwins).not.toHaveBeenCalled();
    expect(products.createUnmatched).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: OFFER_ID,
      productId: TWIN_ID,
      name: 'Target',
      nameOrig: 'Віскі Sample 0,7л',
      merged: false,
      created: false,
    });
  });

  it('refuses a product id that names no bottling', async () => {
    const { service } = makeService();

    await expect(
      service.relink({ id: OFFER_ID, productId: 'missing' as ID }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requires a name when no product id is given', async () => {
    const { service, offers } = makeService();

    await expect(
      service.relink({ id: OFFER_ID, name: '  ', volumeMl: 700 }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(offers.relink).not.toHaveBeenCalled();
  });

  it('relinks to the bottling the attributes match by identity', async () => {
    /**
     * The attributes are the address of the target, not an edit of it: the
     * found bottling's own facts stand, and nothing is created.
     */
    const { service, products, offers } = makeService();

    products.findIdentityTwins.mockResolvedValue([TWIN_ID]);

    const result = await service.relink({
      id: OFFER_ID,
      name: ' Sample Twin ',
      volumeMl: 700,
      age: null,
      abv: 50,
    });

    expect(products.findIdentityTwins).toHaveBeenCalledWith(
      'Sample Twin',
      700,
      null,
    );
    expect(products.createUnmatched).not.toHaveBeenCalled();
    expect(products.updateByIdOrThrow).not.toHaveBeenCalled();
    expect(offers.relink).toHaveBeenCalledWith(OFFER_ID, TWIN_ID);
    expect(result.productId).toBe(TWIN_ID);
    expect(result.created).toBe(false);
  });

  it('creates the bottling, stamped manual, when nothing matches', async () => {
    const { service, products, offers } = makeService(
      new Map([['peated', 'flavor-1' as ID]]),
    );

    const result = await service.relink({
      id: OFFER_ID,
      name: 'Arran Amarone Cask',
      volumeMl: 700,
      age: null,
      abv: 50,
      flavors: ['peated'],
    });

    expect(products.createUnmatched).toHaveBeenCalledWith({
      matchKey: null,
      name: 'Arran Amarone Cask',
      brandOrig: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: 50,
      volumeMl: 700,
      factSources: {
        name: 'manual',
        type: 'manual',
        country: 'manual',
        age: 'manual',
        abv: 'manual',
        volume: 'manual',
      },
    });
    expect(products.setManualFlavors).toHaveBeenCalledWith('product-new', [
      'flavor-1',
    ]);
    expect(offers.relink).toHaveBeenCalledWith(OFFER_ID, 'product-new');
    expect(result).toEqual({
      id: OFFER_ID,
      productId: 'product-new',
      name: 'Arran Amarone Cask',
      nameOrig: 'Віскі Sample 0,7л',
      merged: false,
      created: true,
    });
  });

  it('deletes the emptied bottling the offer left behind', async () => {
    const { service, products, offers } = makeService();

    products.findById.mockResolvedValue({ id: TWIN_ID, name: 'Target' });

    await service.relink({ id: OFFER_ID, productId: TWIN_ID });

    expect(products.deleteIfUnreferenced).toHaveBeenCalledWith(PRODUCT_ID);
    expect(offers.relink.mock.invocationCallOrder[0]).toBeLessThan(
      products.deleteIfUnreferenced.mock.invocationCallOrder[0],
    );
  });

  it('never deletes the target when the offer was already on it', async () => {
    const { service, products, offers } = makeService();

    products.findById.mockResolvedValue({ id: PRODUCT_ID, name: 'Same' });
    offers.relink.mockResolvedValue(PRODUCT_ID);

    await service.relink({ id: OFFER_ID, productId: PRODUCT_ID });

    expect(products.deleteIfUnreferenced).not.toHaveBeenCalled();
  });
});
