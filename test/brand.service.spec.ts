import 'reflect-metadata';

import { CoreBrandService } from '~core/brand';

import { BrandService } from '../src/domain/brand/brand.service';

/**
 * Wires a `BrandService` over a mocked core service.
 *
 * @returns The service plus the mock worth asserting on.
 */
function makeService(): {
  service: BrandService;
  brands: { searchByName: jest.Mock };
  } {
  const brands = {
    searchByName: jest.fn().mockResolvedValue([{ name: 'Glenfiddich' }]),
  };

  const service = new BrandService(brands as unknown as CoreBrandService);

  return { service, brands };
}

describe('BrandService.search', () => {
  it('passes the term through with the requested limit', async () => {
    const { service, brands } = makeService();

    const result = await service.search({ q: 'glen', limit: 5 });

    expect(brands.searchByName).toHaveBeenCalledWith('glen', 5);
    expect(result).toEqual([{ name: 'Glenfiddich' }]);
  });

  it('applies the default limit when the request names none', async () => {
    /**
     * The default lives in the domain service, not the controller — this is
     * the test that keeps it from silently moving.
     */
    const { service, brands } = makeService();

    await service.search({ q: 'glen' });

    expect(brands.searchByName).toHaveBeenCalledWith('glen', 10);
  });
});
