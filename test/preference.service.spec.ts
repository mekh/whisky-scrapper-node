import 'reflect-metadata';

import { CoreBrandService } from '~core/brand';
import { CorePreferenceService } from '~core/preference';
import { CoreProductService } from '~core/product';
import { CoreUserService } from '~core/user';
import { BadRequestError, NotFoundError } from '~errors';
import type { ID, Preference } from '~types';

import { PreferenceService } from '../src/domain/preference/preference.service';

const USER_ID = 'user-1' as ID;
const PRODUCT_ID = 'product-1' as ID;
const OTHER_PRODUCT_ID = 'product-2' as ID;
const BRAND_ID = 'brand-1' as ID;

const STORED: Preference = {
  favorites: [PRODUCT_ID],
  blacklistProducts: [],
  blacklistBrands: ['Ardbeg'],
};

const DETAILS = {
  favorites: [],
  blacklistProducts: [],
  blacklistBrands: [],
};

interface Mocks {
  service: PreferenceService;
  preferences: {
    findByUserId: jest.Mock;
    findDetailsByUserId: jest.Mock;
    addFavorites: jest.Mock;
    removeFavorites: jest.Mock;
    addToBlacklist: jest.Mock;
    removeFromBlacklist: jest.Mock;
  };
  brands: { findIdsByName: jest.Mock };
  products: { findExistingIds: jest.Mock };
  users: { findByIdOrThrow: jest.Mock };
}

/**
 * Wires a `PreferenceService` whose collaborators are mocks: the core service
 * always answers with {@link STORED}, the catalogue contains the given products
 * and brands, and the user lookup succeeds.
 *
 * @param options - Which products and brand names the catalogue is to contain.
 * @returns The service plus the mocks worth asserting on.
 */
function makeService(options: {
  products?: ID[];
  brands?: Map<string, ID>;
} = {}): Mocks {
  const preferences = {
    findByUserId: jest.fn().mockResolvedValue(STORED),
    findDetailsByUserId: jest.fn().mockResolvedValue(DETAILS),
    addFavorites: jest.fn().mockResolvedValue(STORED),
    removeFavorites: jest.fn().mockResolvedValue(STORED),
    addToBlacklist: jest.fn().mockResolvedValue(STORED),
    removeFromBlacklist: jest.fn().mockResolvedValue(STORED),
  };

  const brands = {
    findIdsByName: jest.fn().mockResolvedValue(options.brands ?? new Map()),
  };

  const products = {
    findExistingIds: jest.fn().mockResolvedValue(
      new Set(options.products ?? [PRODUCT_ID, OTHER_PRODUCT_ID]),
    ),
  };

  const users = {
    findByIdOrThrow: jest.fn().mockResolvedValue({ id: USER_ID }),
  };

  const service = new PreferenceService(
    preferences as unknown as CorePreferenceService,
    brands as unknown as CoreBrandService,
    products as unknown as CoreProductService,
    users as unknown as CoreUserService,
  );

  return { service, preferences, brands, products, users };
}

describe('PreferenceService reads', () => {
  it('reads own preferences without a user lookup', async () => {
    const { service, preferences, users } = makeService();

    const result = await service.getOwn(USER_ID);

    expect(result).toBe(STORED);
    expect(preferences.findByUserId).toHaveBeenCalledWith(USER_ID);
    expect(users.findByIdOrThrow).not.toHaveBeenCalled();
  });

  it('reads the resolved details without a user lookup', async () => {
    const { service, preferences, users } = makeService();

    const result = await service.getOwnDetails(USER_ID);

    expect(result).toBe(DETAILS);
    expect(preferences.findDetailsByUserId).toHaveBeenCalledWith(USER_ID);
    expect(users.findByIdOrThrow).not.toHaveBeenCalled();
  });

  it('checks the user exists before reading someone else', async () => {
    const { service, preferences, users } = makeService();

    await service.getForUser(USER_ID);

    expect(users.findByIdOrThrow).toHaveBeenCalledWith(USER_ID);
    expect(preferences.findByUserId).toHaveBeenCalledWith(USER_ID);
  });

  it('propagates the 404 for an unknown user, not an empty set', async () => {
    const { service, preferences, users } = makeService();

    users.findByIdOrThrow.mockRejectedValue(new NotFoundError('User'));

    await expect(service.getForUser(USER_ID)).rejects.toThrow(NotFoundError);
    expect(preferences.findByUserId).not.toHaveBeenCalled();
  });
});

describe('PreferenceService favorites', () => {
  it('adds the requested ids and returns the fresh state', async () => {
    const { service, preferences } = makeService();

    const result = await service.addFavorites(USER_ID, {
      productIds: [PRODUCT_ID],
    });

    expect(preferences.addFavorites)
      .toHaveBeenCalledWith(USER_ID, [PRODUCT_ID]);
    expect(result).toBe(STORED);
  });

  it('rejects an unknown product without writing anything', async () => {
    const { service, preferences } = makeService({ products: [] });

    await expect(
      service.addFavorites(USER_ID, { productIds: [PRODUCT_ID] }),
    ).rejects.toThrow(BadRequestError);
    expect(preferences.addFavorites).not.toHaveBeenCalled();
  });

  it('names every unresolved id in the error data', async () => {
    const { service } = makeService({ products: [PRODUCT_ID] });

    const failure = service.addFavorites(USER_ID, {
      productIds: [PRODUCT_ID, OTHER_PRODUCT_ID],
    });

    await expect(failure).rejects.toMatchObject({
      data: { products: [OTHER_PRODUCT_ID] },
    });
  });

  it('accepts an empty list as a documented no-op', async () => {
    const { service, preferences, products } = makeService();

    const result = await service.addFavorites(USER_ID, { productIds: [] });

    expect(products.findExistingIds).not.toHaveBeenCalled();
    expect(preferences.addFavorites).toHaveBeenCalledWith(USER_ID, []);
    expect(result).toBe(STORED);
  });

  it('removes without checking the ids exist', async () => {
    const { service, preferences, products } = makeService({ products: [] });

    await service.removeFavorites(USER_ID, { productIds: [PRODUCT_ID] });

    expect(products.findExistingIds).not.toHaveBeenCalled();
    expect(preferences.removeFavorites)
      .toHaveBeenCalledWith(USER_ID, [PRODUCT_ID]);
  });
});

describe('PreferenceService blacklist', () => {
  it('resolves brand names to ids before writing', async () => {
    const { service, preferences, brands } = makeService({
      brands: new Map([['Ardbeg', BRAND_ID]]),
    });

    await service.addToBlacklist(USER_ID, { brands: ['Ardbeg'] });

    expect(brands.findIdsByName).toHaveBeenCalledWith(['Ardbeg']);
    expect(preferences.addToBlacklist).toHaveBeenCalledWith(USER_ID, {
      productIds: [],
      brandIds: [BRAND_ID],
    });
  });

  it('rejects an unknown brand without writing anything', async () => {
    const { service, preferences } = makeService();

    const failure = service.addToBlacklist(USER_ID, { brands: ['Nope'] });

    await expect(failure).rejects.toMatchObject({
      message: 'Unknown brand',
      data: { brands: ['Nope'] },
    });
    expect(preferences.addToBlacklist).not.toHaveBeenCalled();
  });

  it('carries both lists through when both are given', async () => {
    const { service, preferences } = makeService({
      brands: new Map([['Ardbeg', BRAND_ID]]),
    });

    await service.addToBlacklist(USER_ID, {
      productIds: [PRODUCT_ID],
      brands: ['Ardbeg'],
    });

    expect(preferences.addToBlacklist).toHaveBeenCalledWith(USER_ID, {
      productIds: [PRODUCT_ID],
      brandIds: [BRAND_ID],
    });
  });

  it.each([
    ['no fields', {}],
    ['two empty lists', { productIds: [], brands: [] }],
  ])('rejects a request naming nothing (%s)', async (_label, input) => {
    const { service, preferences } = makeService();

    await expect(service.addToBlacklist(USER_ID, input))
      .rejects.toThrow(BadRequestError);
    await expect(service.removeFromBlacklist(USER_ID, input))
      .rejects.toThrow(BadRequestError);
    expect(preferences.addToBlacklist).not.toHaveBeenCalled();
    expect(preferences.removeFromBlacklist).not.toHaveBeenCalled();
  });

  it('removes with no product check but a strict brand lookup', async () => {
    const { service, preferences, products, brands } = makeService({
      products: [],
      brands: new Map([['Ardbeg', BRAND_ID]]),
    });

    await service.removeFromBlacklist(USER_ID, {
      productIds: [PRODUCT_ID],
      brands: ['Ardbeg'],
    });

    expect(products.findExistingIds).not.toHaveBeenCalled();
    expect(brands.findIdsByName).toHaveBeenCalledWith(['Ardbeg']);
    expect(preferences.removeFromBlacklist).toHaveBeenCalledWith(USER_ID, {
      productIds: [PRODUCT_ID],
      brandIds: [BRAND_ID],
    });
  });

  it('rejects an unknown brand on removal too', async () => {
    const { service, preferences } = makeService();

    await expect(
      service.removeFromBlacklist(USER_ID, { brands: ['Nope'] }),
    ).rejects.toThrow(BadRequestError);
    expect(preferences.removeFromBlacklist).not.toHaveBeenCalled();
  });
});

describe('PreferenceService per-user variants', () => {
  it('checks the user exists before reading their details', async () => {
    const { service, preferences, users } = makeService();

    const result = await service.getDetailsForUser(USER_ID);

    expect(users.findByIdOrThrow).toHaveBeenCalledWith(USER_ID);
    expect(preferences.findDetailsByUserId).toHaveBeenCalledWith(USER_ID);
    expect(result).toBe(DETAILS);
  });

  it(
    'propagates the 404 for unknown-user details, not empty lists',
    async () => {
      const { service, preferences, users } = makeService();

      users.findByIdOrThrow.mockRejectedValue(new NotFoundError('User'));

      await expect(service.getDetailsForUser(USER_ID))
        .rejects.toThrow(NotFoundError);
      expect(preferences.findDetailsByUserId).not.toHaveBeenCalled();
    },
  );

  it('checks the user exists before each write', async () => {
    const { service, preferences, users } = makeService({
      brands: new Map([['Ardbeg', BRAND_ID]]),
    });
    const favorites = { productIds: [PRODUCT_ID] };
    const blacklist = { brands: ['Ardbeg'] };

    await service.addFavoritesForUser(USER_ID, favorites);
    await service.removeFavoritesForUser(USER_ID, favorites);
    await service.addToBlacklistForUser(USER_ID, blacklist);
    await service.removeFromBlacklistForUser(USER_ID, blacklist);

    expect(users.findByIdOrThrow).toHaveBeenCalledTimes(4);
    expect(preferences.addFavorites)
      .toHaveBeenCalledWith(USER_ID, [PRODUCT_ID]);
    expect(preferences.removeFavorites)
      .toHaveBeenCalledWith(USER_ID, [PRODUCT_ID]);
    expect(preferences.addToBlacklist).toHaveBeenCalledWith(USER_ID, {
      productIds: [],
      brandIds: [BRAND_ID],
    });
    expect(preferences.removeFromBlacklist).toHaveBeenCalledWith(USER_ID, {
      productIds: [],
      brandIds: [BRAND_ID],
    });
  });

  it('rejects a write for an unknown user before any validation', async () => {
    const { service, preferences, products, users } = makeService();

    users.findByIdOrThrow.mockRejectedValue(new NotFoundError('User'));

    await expect(
      service.addFavoritesForUser(USER_ID, { productIds: [PRODUCT_ID] }),
    ).rejects.toThrow(NotFoundError);
    expect(products.findExistingIds).not.toHaveBeenCalled();
    expect(preferences.addFavorites).not.toHaveBeenCalled();
  });

  it('still runs the inherited validation after the user check', async () => {
    const { service, preferences } = makeService({ products: [] });

    await expect(
      service.addFavoritesForUser(USER_ID, { productIds: [PRODUCT_ID] }),
    ).rejects.toThrow(BadRequestError);
    await expect(service.addToBlacklistForUser(USER_ID, {}))
      .rejects.toThrow(BadRequestError);
    await expect(service.removeFromBlacklistForUser(USER_ID, {}))
      .rejects.toThrow(BadRequestError);
    expect(preferences.addFavorites).not.toHaveBeenCalled();
    expect(preferences.addToBlacklist).not.toHaveBeenCalled();
    expect(preferences.removeFromBlacklist).not.toHaveBeenCalled();
  });
});
