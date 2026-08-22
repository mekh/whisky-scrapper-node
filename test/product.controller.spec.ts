import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Action, Resource } from '~enums';
import type { AuthPermissionMeta } from '~types';

import { ProductController } from '../src/domain/product/product.controller';

import type { ProductService } from '../src/domain/product/product.service';

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    ProductController.prototype,
    handler,
  )?.value as object;

  return Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, method) as
    | AuthPermissionMeta
    | undefined;
}

/**
 * Builds a controller over a fully mocked service.
 *
 * @returns The controller and the service mock.
 */
function makeController(): {
  controller: ProductController;
  service: Record<string, jest.Mock>;
  } {
  const service = {
    search: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue('updated'),
  };

  const controller = new ProductController(
    service as unknown as ProductService,
  );

  return { controller, service };
}

describe('ProductController permissions', () => {
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

  it('update requires the product edit scope', () => {
    const meta = metaOf('update');

    expect(meta?.permissions).toEqual([[Resource.PRODUCT, Action.EDIT]]);
    expect(meta?.isPublic).toBe(false);
  });
});

describe('ProductController delegation', () => {
  it('hands the search query through untouched', async () => {
    const { controller, service } = makeController();
    const query = { q: 'glen', limit: 5 };

    await controller.search(query);

    expect(service.search).toHaveBeenCalledWith(query);
  });

  it('hands the update body through untouched', async () => {
    const { controller, service } = makeController();
    const body = { id: 'offer-1', name: 'Renamed' };

    await controller.update(body);

    expect(service.update).toHaveBeenCalledWith(body);
  });
});
