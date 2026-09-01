import 'reflect-metadata';

import type { CoreProducerService } from '~core/producer';

import { BrandService } from '../src/domain/brand/brand.service';

/**
 * Wires a `BrandService` over a mocked core service.
 *
 * @returns The service plus the mock worth asserting on.
 */
function makeService(): {
  service: BrandService;
  producers: { searchByName: jest.Mock };
  } {
  const producers = {
    searchByName: jest.fn().mockResolvedValue([{ name: 'Glenfiddich' }]),
  };

  const service = new BrandService(
    producers as unknown as CoreProducerService,
  );

  return { service, producers };
}

describe('BrandService.search', () => {
  it('passes the term through with the requested limit', async () => {
    const { service, producers } = makeService();

    const result = await service.search({ q: 'glen', limit: 5 });

    expect(producers.searchByName).toHaveBeenCalledWith('glen', 5);
    expect(result).toEqual([{ name: 'Glenfiddich' }]);
  });

  it('applies the default limit when the request names none', async () => {
    /**
     * The default lives in the domain service, not the controller — this is
     * the test that keeps it from silently moving.
     */
    const { service, producers } = makeService();

    await service.search({ q: 'glen' });

    expect(producers.searchByName).toHaveBeenCalledWith('glen', 10);
  });
});
