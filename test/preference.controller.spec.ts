import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Action, PermissionMode, Resource } from '~enums';
import type { AuthPermissionMeta, CtxUser, ID } from '~types';

import { PreferenceController } from '../src/domain/preference/preference.controller';

import type { PreferenceService } from '../src/domain/preference/preference.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

const OWN_HANDLERS = [
  'own',
  'details',
  'addFavorites',
  'removeFavorites',
  'addToBlacklist',
  'removeFromBlacklist',
] as const;

const FOR_USER_WRITE_HANDLERS = [
  'addFavoritesForUser',
  'removeFavoritesForUser',
  'addToBlacklistForUser',
  'removeFromBlacklistForUser',
] as const;

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    PreferenceController.prototype,
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
  controller: PreferenceController;
  service: Record<string, jest.Mock>;
  } {
  const service = {
    getOwn: jest.fn().mockResolvedValue('own'),
    getOwnDetails: jest.fn().mockResolvedValue('own-details'),
    getForUser: jest.fn().mockResolvedValue('for-user'),
    getDetailsForUser: jest.fn().mockResolvedValue('for-user-details'),
    addFavorites: jest.fn().mockResolvedValue('add-fav'),
    removeFavorites: jest.fn().mockResolvedValue('remove-fav'),
    addToBlacklist: jest.fn().mockResolvedValue('add-black'),
    removeFromBlacklist: jest.fn().mockResolvedValue('remove-black'),
    addFavoritesForUser: jest.fn().mockResolvedValue('add-fav-user'),
    removeFavoritesForUser: jest.fn().mockResolvedValue('remove-fav-user'),
    addToBlacklistForUser: jest.fn().mockResolvedValue('add-black-user'),
    removeFromBlacklistForUser: jest.fn()
      .mockResolvedValue('remove-black-user'),
  };

  const controller = new PreferenceController(
    service as unknown as PreferenceService,
  );

  return { controller, service };
}

describe('PreferenceController permissions', () => {
  it.each([...OWN_HANDLERS])(
    '%s is open to any authenticated user',
    (handler) => {
      /**
       * A handler shipped without `@Plain` would pass every other test and then
       * 500 at runtime — `getMetaOrThrow` treats missing metadata as an
       * unexposed resource. This is the guard against that.
       */
      const meta = metaOf(handler);

      expect(meta?.permissions).toEqual([[Resource.AUTHENTICATED]]);
      expect(meta?.isPublic).toBe(false);
    },
  );

  it.each(['byUser', 'byUserDetails'])(
    '%s accepts the read scope holder or the user themselves',
    (handler) => {
      const meta = metaOf(handler);

      expect(meta?.mode).toBe(PermissionMode.OR);
      expect(meta?.isPublic).toBe(false);
      expect(meta?.permissions).toHaveLength(2);
      expect(meta?.permissions[0])
        .toEqual([Resource.PREFERENCE, Action.READ]);
      expect(meta?.permissions[1][0]).toBe(Resource.SELF);
      expect(typeof meta?.permissions[1][1]).toBe('function');
    },
  );

  it.each([...FOR_USER_WRITE_HANDLERS])(
    '%s accepts the update scope holder or the user themselves',
    (handler) => {
      const meta = metaOf(handler);

      expect(meta?.mode).toBe(PermissionMode.OR);
      expect(meta?.isPublic).toBe(false);
      expect(meta?.permissions).toHaveLength(2);
      expect(meta?.permissions[0])
        .toEqual([Resource.PREFERENCE, Action.UPDATE]);
      expect(meta?.permissions[1][0]).toBe(Resource.SELF);
      expect(typeof meta?.permissions[1][1]).toBe('function');
    },
  );
});

describe('PreferenceController delegation', () => {
  it('reads with the authenticated id, never the request body', async () => {
    const { controller, service } = makeController();

    await controller.own(USER);

    expect(service.getOwn).toHaveBeenCalledWith(USER.id);
  });

  it('reads the resolved details with the authenticated id', async () => {
    const { controller, service } = makeController();

    await controller.details(USER);

    expect(service.getOwnDetails).toHaveBeenCalledWith(USER.id);
  });

  it('reads another user by the route parameter', async () => {
    const { controller, service } = makeController();

    await controller.byUser({ userId: 'user-2' as ID });

    expect(service.getForUser).toHaveBeenCalledWith('user-2');
  });

  it('hands each mutation the caller id and the body untouched', async () => {
    const { controller, service } = makeController();
    const favorites = { productIds: ['product-1' as ID] };
    const blacklist = { productIds: ['product-2' as ID], brands: ['Ardbeg'] };

    await controller.addFavorites(USER, favorites);
    await controller.removeFavorites(USER, favorites);
    await controller.addToBlacklist(USER, blacklist);
    await controller.removeFromBlacklist(USER, blacklist);

    expect(service.addFavorites).toHaveBeenCalledWith(USER.id, favorites);
    expect(service.removeFavorites).toHaveBeenCalledWith(USER.id, favorites);
    expect(service.addToBlacklist).toHaveBeenCalledWith(USER.id, blacklist);
    expect(service.removeFromBlacklist)
      .toHaveBeenCalledWith(USER.id, blacklist);
  });

  it("reads another user's details by the route parameter", async () => {
    const { controller, service } = makeController();

    await controller.byUserDetails({ userId: 'user-2' as ID });

    expect(service.getDetailsForUser).toHaveBeenCalledWith('user-2');
  });

  it(
    'hands each per-user mutation the route parameter and the body untouched',
    async () => {
      /**
       * The id must come from the route, never from the caller's own token —
       * passing `user.id` here would silently edit the admin instead of the
       * target user.
       */
      const { controller, service } = makeController();
      const target = { userId: 'user-2' as ID };
      const favorites = { productIds: ['product-1' as ID] };
      const blacklist = {
        productIds: ['product-2' as ID],
        brands: ['Ardbeg'],
      };

      await controller.addFavoritesForUser(target, favorites);
      await controller.removeFavoritesForUser(target, favorites);
      await controller.addToBlacklistForUser(target, blacklist);
      await controller.removeFromBlacklistForUser(target, blacklist);

      expect(service.addFavoritesForUser)
        .toHaveBeenCalledWith('user-2', favorites);
      expect(service.removeFavoritesForUser)
        .toHaveBeenCalledWith('user-2', favorites);
      expect(service.addToBlacklistForUser)
        .toHaveBeenCalledWith('user-2', blacklist);
      expect(service.removeFromBlacklistForUser)
        .toHaveBeenCalledWith('user-2', blacklist);
    },
  );
});
