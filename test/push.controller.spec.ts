import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Action, Resource } from '~enums';
import type { AuthPermissionMeta, CtxUser, ID } from '~types';

import { PushController } from '../src/domain/push/push.controller';

import type { PushDigestService } from '../src/domain/push/push-digest.service';
import type { PushService } from '../src/domain/push/push.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

const OWN_HANDLERS = [
  'config',
  'devices',
  'subscribe',
  'unsubscribe',
  'test',
] as const;

/**
 * Reads the permission metadata a controller handler carries.
 *
 * @param handler - Name of the handler method.
 * @returns The attached metadata, or undefined when the handler carries none.
 */
function metaOf(handler: string): AuthPermissionMeta | undefined {
  const method = Object.getOwnPropertyDescriptor(
    PushController.prototype,
    handler,
  )?.value as object;

  return Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, method) as
    | AuthPermissionMeta
    | undefined;
}

/**
 * Builds a controller over fully mocked services.
 *
 * @returns The controller and both service mocks.
 */
function makeController(): {
  controller: PushController;
  push: Record<string, jest.Mock>;
  digest: Record<string, jest.Mock>;
  } {
  const push = {
    clientConfig: jest.fn().mockReturnValue('config'),
    devices: jest.fn().mockResolvedValue('devices'),
    subscribe: jest.fn().mockResolvedValue('subscribed'),
    unsubscribe: jest.fn().mockResolvedValue('unsubscribed'),
    sendTest: jest.fn().mockResolvedValue('tested'),
  };

  const digest = {
    dispatch: jest.fn().mockResolvedValue('dispatched'),
  };

  const controller = new PushController(
    push as unknown as PushService,
    digest as unknown as PushDigestService,
  );

  return { controller, push, digest };
}

describe('PushController permissions', () => {
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

  it('dispatch requires the sync scope, like starting a sync', () => {
    const meta = metaOf('dispatch');

    expect(meta?.permissions).toEqual([[Resource.STORE, Action.SYNC]]);
    expect(meta?.isPublic).toBe(false);
  });
});

describe('PushController delegation', () => {
  it('answers the client config without touching the user', () => {
    const { controller, push } = makeController();

    controller.config();

    expect(push.clientConfig).toHaveBeenCalledWith();
  });

  it('lists devices for the authenticated id only', async () => {
    const { controller, push } = makeController();

    await controller.devices(USER);

    expect(push.devices).toHaveBeenCalledWith(USER.id);
  });

  it('subscribes the caller with the body and the request UA', async () => {
    const { controller, push } = makeController();
    const body = { endpoint: 'https://p.example/e1', p256dh: 'k', auth: 'a' };

    await controller.subscribe(USER, body, 'agent');

    expect(push.subscribe).toHaveBeenCalledWith(USER.id, body, 'agent');
  });

  it('unsubscribes the caller by the endpoint alone', async () => {
    const { controller, push } = makeController();

    await controller.unsubscribe(USER, { endpoint: 'https://p.example/e1' });

    expect(push.unsubscribe)
      .toHaveBeenCalledWith(USER.id, 'https://p.example/e1');
  });

  it('sends the test to the caller', async () => {
    const { controller, push } = makeController();

    await controller.test(USER);

    expect(push.sendTest).toHaveBeenCalledWith(USER.id);
  });

  it('hands the dispatch the body untouched', async () => {
    const { controller, digest } = makeController();
    const body = { capturedOn: '2026-08-23' };

    await controller.dispatch(body);

    expect(digest.dispatch).toHaveBeenCalledWith(body);
  });
});
