import 'reflect-metadata';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Action, Resource } from '~enums';

import { StoreController } from '../../src/domain/store/store.controller';

import type { AuthPermissionMeta, Response } from '~types';
import type { StoreService } from '../../src/domain/store/store.service';

interface ReplyStub {
  /**
   * The stub, shaped as the Fastify reply the handler expects.
   */
  reply: Response;

  /**
   * The `header` spy.
   */
  header: jest.Mock;

  /**
   * The `send` spy.
   */
  send: jest.Mock;
}

/**
 * Builds a Fastify reply stub that records what the handler sent.
 *
 * @returns The stub plus its `header`/`send` spies.
 */
function makeReply(): ReplyStub {
  const send = jest.fn().mockResolvedValue(undefined);
  const header = jest.fn();
  const reply = { header, send };

  header.mockReturnValue(reply);

  return { reply: reply as unknown as Response, header, send };
}

describe('StoreController.syncLogFile', () => {
  it('sends the log text verbatim as plain text', async () => {
    const storeService = {
      syncLogFile: jest.fn().mockResolvedValue('13:00:00 INFO    line\n'),
    };
    const controller = new StoreController(
      storeService as unknown as StoreService,
    );
    const { reply, header, send } = makeReply();

    await controller.syncLogFile({ slug: 'maudau', id: 'log-1' }, reply);

    expect(storeService.syncLogFile).toHaveBeenCalledWith('maudau', 'log-1');
    expect(header).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; charset=utf-8',
    );
    expect(send).toHaveBeenCalledWith('13:00:00 INFO    line\n');
  });

  it('carries the permission metadata the guard needs', () => {
    /**
     * The handler takes the reply over instead of using `@Plain`, which is
     * what normally attaches this metadata — so a missing standalone
     * `@Permission` would leave the route unexposed as far as
     * `ContextManager.getMetaOrThrow` is concerned.
     */
    const handler = Object.getOwnPropertyDescriptor(
      StoreController.prototype,
      'syncLogFile',
    )?.value as object;
    const meta = Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, handler) as
      | AuthPermissionMeta
      | undefined;

    expect(meta?.permissions).toEqual([[Resource.STORE, Action.READ]]);
    expect(meta?.isPublic).toBe(false);
  });
});
