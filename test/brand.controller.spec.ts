import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Resource } from '~enums';
import type { AuthPermissionMeta } from '~types';

import { BrandController } from '../src/domain/brand/brand.controller';

import type { BrandService } from '../src/domain/brand/brand.service';

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    BrandController.prototype,
    handler,
  )?.value as object;

  return Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, method) as
    | AuthPermissionMeta
    | undefined;
}

describe('BrandController', () => {
  /**
   * A handler shipped without `@Plain` would pass every other test and then
   * 500 at runtime — `getMetaOrThrow` treats missing metadata as an unexposed
   * resource. This is the guard against that.
   */
  it('search is open to any authenticated user', () => {
    const meta = metaOf('search');

    expect(meta?.permissions).toEqual([[Resource.AUTHENTICATED]]);
    expect(meta?.isPublic).toBe(false);
  });

  it('hands the search query through untouched', async () => {
    const service = { search: jest.fn().mockResolvedValue([]) };
    const controller = new BrandController(
      service as unknown as BrandService,
    );
    const query = { q: 'glen', limit: 5 };

    await controller.search(query);

    expect(service.search).toHaveBeenCalledWith(query);
  });
});
