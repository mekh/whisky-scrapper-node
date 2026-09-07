import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { CollectionTimelineGranularity, Resource } from '~enums';
import type { AuthPermissionMeta, CtxUser, ID } from '~types';

import { CollectionStatsService } from '../src/domain/collection/collection-stats.service';
import { CollectionController } from '../src/domain/collection/collection.controller';

import type { CollectionService } from '../src/domain/collection/collection.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

/**
 * Every handler on this controller answers only an authenticated caller —
 * unlike `/preference` and `/quick-filter` there is no self/other split, so
 * one shared list drives the whole permission check.
 */
const ALL_HANDLERS = [
  'own',
  'ids',
  'getStats',
  'create',
  'update',
  'remove',
] as const;

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    CollectionController.prototype,
    handler,
  )?.value as object;

  return Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, method) as
    | AuthPermissionMeta
    | undefined;
}

interface Mocks {
  controller: CollectionController;
  collection: Record<string, jest.Mock>;
  stats: Record<string, jest.Mock>;
}

/**
 * Builds a controller over two fully mocked services.
 *
 * @returns The controller and both service mocks.
 */
function makeController(): Mocks {
  /**
   * Every handler but `remove` is wrapped by `@Plain(…)`, which runs
   * `plainToInstance` over the result: `own` is array-wrapped and so must
   * answer with a list, the rest answer with a single truthy sentinel.
   * `remove` carries no `@Plain` at all, so its own mock's return value is
   * never inspected.
   */
  const collection = {
    getOwn: jest.fn().mockResolvedValue([]),
    getOwnIds: jest.fn().mockResolvedValue('ids'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  const stats = {
    getOwn: jest.fn().mockResolvedValue('stats'),
  };

  const controller = new CollectionController(
    collection as unknown as CollectionService,
    stats as unknown as CollectionStatsService,
  );

  return { controller, collection, stats };
}

describe('CollectionController permissions', () => {
  it.each([...ALL_HANDLERS])(
    '%s is open to any authenticated user',
    (handler) => {
      /**
       * A handler shipped without `@Plain`/`@Permission` would pass every
       * other test and then 500 at runtime — `getMetaOrThrow` treats missing
       * metadata as an unexposed resource. This is the guard against that.
       */
      const meta = metaOf(handler);

      expect(meta?.permissions).toEqual([[Resource.AUTHENTICATED]]);
      expect(meta?.isPublic).toBe(false);
    },
  );
});

describe('CollectionController delegation', () => {
  it('reads the whole collection with the authenticated id', async () => {
    const { controller, collection } = makeController();

    await controller.own(USER);

    expect(collection.getOwn).toHaveBeenCalledWith(USER.id);
  });

  it('reads the membership ids with the authenticated id', async () => {
    const { controller, collection } = makeController();

    await controller.ids(USER);

    expect(collection.getOwnIds).toHaveBeenCalledWith(USER.id);
  });

  it(
    'hands the stats query to the stats service, not the collection one',
    async () => {
      const { controller, collection, stats } = makeController();
      const query = {
        from: '2026-01',
        to: '2026-06',
        granularity: CollectionTimelineGranularity.YEAR,
      };

      await controller.getStats(USER, query);

      expect(stats.getOwn).toHaveBeenCalledWith(USER.id, query);
      expect(collection.getOwn).not.toHaveBeenCalled();
    },
  );

  it('hands create the caller id and the body untouched', async () => {
    const { controller, collection } = makeController();
    const body = {
      productId: 'product-1' as ID,
      rating: 8.5,
      barcode: '1234567890123',
      notes: 'A gift from my brother',
      purchase: {
        purchasedOn: '2026-01-10',
        price: 1500,
        storeSlug: 'maudau',
      },
    };

    await controller.create(USER, body);

    expect(collection.create).toHaveBeenCalledWith(USER.id, body);
  });

  it('scopes update to the caller id and the route id', async () => {
    const { controller, collection } = makeController();
    const params = { id: 'collection-1' as ID };

    /**
     * The purchase changes ride in the same body; the controller hands the
     * whole thing on untouched rather than splitting it into the per-purchase
     * calls the API no longer has.
     */
    const body = {
      rating: 9,
      notes: '',
      purchases: {
        add: [{ purchasedOn: '2026-02-01', price: 999, storeSlug: 'rozetka' }],
        update: [{ id: 'purchase-1' as ID, price: 500, clearStore: true }],
        remove: ['purchase-2' as ID],
      },
    };

    await controller.update(USER, params, body);

    expect(collection.update)
      .toHaveBeenCalledWith(USER.id, params.id, body);
  });

  it('scopes delete to the caller id and the route id', async () => {
    const { controller, collection } = makeController();
    const params = { id: 'collection-1' as ID };

    await controller.remove(USER, params);

    expect(collection.remove).toHaveBeenCalledWith(USER.id, params.id);
  });
});
