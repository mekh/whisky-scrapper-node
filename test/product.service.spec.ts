import 'reflect-metadata';

import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { BadRequestError } from '~errors';
import type { ID, ProductUpdateInput } from '~types';

import { CoreTypeService } from '../src/core/type';
import { ProductService } from '../src/domain/product/product.service';

const OFFER_ID = 'offer-1' as ID;
const PRODUCT_ID = 'product-1' as ID;

interface Mocks {
  service: ProductService;
  products: { setManualFlavors: jest.Mock; updateByIdOrThrow: jest.Mock };
  flavors: { findIdsByName: jest.Mock };
}

/**
 * Wires a `ProductService` whose collaborators are mocks: the offer resolves to
 * one bottling, the column patch succeeds, and the flavor lookup answers with
 * the given name → id pairs (a name missing from the map is an unknown flavor).
 *
 * @param known - Flavor names the reference table is to contain.
 * @returns The service plus the mocks worth asserting on.
 */
function makeService(known: Map<string, ID> = new Map()): Mocks {
  const products = {
    updateByIdOrThrow: jest.fn().mockResolvedValue({ name: 'Sample' }),
    setManualFlavors: jest.fn().mockResolvedValue(undefined),
  };

  const offers = {
    findOfferRefById: jest.fn().mockResolvedValue({
      productId: PRODUCT_ID,
      nameOrig: 'Віскі Sample 0,7л',
    }),
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

  return { service, products, flavors };
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
