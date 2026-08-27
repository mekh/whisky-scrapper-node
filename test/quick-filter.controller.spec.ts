import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Action, PermissionMode, Resource } from '~enums';
import type { AuthPermissionMeta, CtxUser, ID } from '~types';

import { QuickFilterController } from '../src/domain/quick-filter/quick-filter.controller';

import type { QuickFilterService } from '../src/domain/quick-filter/quick-filter.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

const OWN_HANDLERS = ['own', 'create', 'update', 'remove'] as const;

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    QuickFilterController.prototype,
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
  controller: QuickFilterController;
  service: Record<string, jest.Mock>;
  } {
  /**
   * Every handler is wrapped by `@Plain([QuickFilterType], …)`, which runs
   * `plainToInstance` over the result — so the mocks must answer with lists,
   * not sentinels.
   */
  const service = {
    getOwn: jest.fn().mockResolvedValue([]),
    getForUser: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue([]),
    remove: jest.fn().mockResolvedValue([]),
  };

  const controller = new QuickFilterController(
    service as unknown as QuickFilterService,
  );

  return { controller, service };
}

describe('QuickFilterController permissions', () => {
  it.each([...OWN_HANDLERS])(
    '%s is open to any authenticated user',
    (handler) => {
      /**
       * A handler shipped without `@Plain` would pass every other test and
       * then 500 at runtime — `getMetaOrThrow` treats missing metadata as an
       * unexposed resource. This is the guard against that.
       */
      const meta = metaOf(handler);

      expect(meta?.permissions).toEqual([[Resource.AUTHENTICATED]]);
      expect(meta?.isPublic).toBe(false);
    },
  );

  it('byUser accepts the read scope holder or the user themselves', () => {
    const meta = metaOf('byUser');

    expect(meta?.mode).toBe(PermissionMode.OR);
    expect(meta?.isPublic).toBe(false);
    expect(meta?.permissions).toHaveLength(2);
    expect(meta?.permissions[0])
      .toEqual([Resource.QUICK_FILTER, Action.READ]);
    expect(meta?.permissions[1][0]).toBe(Resource.SELF);
    expect(typeof meta?.permissions[1][1]).toBe('function');
  });
});

describe('QuickFilterController delegation', () => {
  it('reads with the authenticated id, never the request body', async () => {
    const { controller, service } = makeController();

    await controller.own(USER);

    expect(service.getOwn).toHaveBeenCalledWith(USER.id);
  });

  it('reads another user by the route parameter', async () => {
    const { controller, service } = makeController();

    await controller.byUser({ userId: 'user-2' as ID });

    expect(service.getForUser).toHaveBeenCalledWith('user-2');
  });

  it('hands create the caller id and the body untouched', async () => {
    /**
     * The payload must reach the service byte-identical: the controller is the
     * one place a stray transform would silently drop an unknown dimension.
     */
    const { controller, service } = makeController();
    const body = {
      name: 'Islay',
      filters: { countries: ['gb'], regions: ['islay'] },
    };

    await controller.create(USER, body);

    expect(service.create).toHaveBeenCalledWith(USER.id, body);

    const [, sent] = service.create.mock.calls[0] as [ID, typeof body];

    expect(sent.filters).toEqual(body.filters);
  });

  it('scopes update to the caller and the route id', async () => {
    const { controller, service } = makeController();
    const body = { name: 'Renamed' };

    await controller.update(USER, { id: 'qf-1' as ID }, body);

    expect(service.update).toHaveBeenCalledWith(USER.id, 'qf-1', body);
  });

  it('scopes delete to the caller and the route id', async () => {
    const { controller, service } = makeController();

    await controller.remove(USER, { id: 'qf-1' as ID });

    expect(service.remove).toHaveBeenCalledWith(USER.id, 'qf-1');
  });
});
