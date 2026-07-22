import 'reflect-metadata';

import { ExecutionContext } from '@nestjs/common';

import { ContextManager } from '~app/context';
import { PermissionGuard } from '~app/guards';
import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { Permission } from '~decorators/auth';
import { Paginated, Plain } from '~decorators/types';
import { Action, PermissionMode, Resource } from '~enums';
import type {
  AuthPermissionMeta,
  CanDo,
  CtxManager,
  CtxUser,
  PermissionMap,
} from '~types';

// Sentinel handed to every CanDo callback so tests can assert identity.
const MANAGER = { tag: 'ctx-manager' } as unknown as CtxManager;

const allow: CanDo = () => true;
const deny: CanDo = () => false;

// Response DTO stand-in for the `@Plain` / `@Paginated` decorators.
class DummyDto {}

/**
 * Applies a method decorator to a throwaway handler and returns the
 * permission metadata it attached.
 *
 * @param dec - The decorator under test (e.g. a `Permission(...)` result).
 * @returns The `AuthPermissionMeta` stored on the decorated handler.
 */
function metaFor(dec: MethodDecorator): AuthPermissionMeta {
  class Handler {
    /** Decorator target; never invoked. */
    public route(): void {}
  }

  const desc = Object.getOwnPropertyDescriptor(
    Handler.prototype,
    'route',
  )!;

  dec(Handler.prototype, 'route', desc);

  return Reflect.getMetadata(PERMISSION_META_INJECT_TOKEN, desc.value);
}

/**
 * Builds a `CtxUser`, overriding defaults as needed.
 *
 * @param over - Fields to override on the default user shape.
 * @returns A `CtxUser` suitable for the fake context.
 */
const asUser = (
  over: Partial<CtxUser> = {},
): CtxUser => ({ id: 'u1', sid: 's1', ...over } as CtxUser);

/**
 * Runs `PermissionGuard.canActivate` against pre-built metadata, faking the
 * request context and the current user.
 *
 * @param meta - The permission metadata the handler would carry.
 * @param user - The current user, or `null` for an anonymous request.
 * @returns Whether the guard authorizes the request.
 */
function runGuard(
  meta: AuthPermissionMeta,
  user: CtxUser | null,
): Promise<boolean> {
  const guard = new PermissionGuard();

  const ctx = {
    user,
    isResourcePublic: (): boolean => meta.isPublic,
    getMetaOrThrow: (): AuthPermissionMeta => meta,
    manager: MANAGER,
  };

  jest
    .spyOn(ContextManager, 'create')
    .mockReturnValue(ctx as unknown as ContextManager);

  return guard.canActivate({} as ExecutionContext);
}

/**
 * Asserts the guard verdict for a decorator and user in one step.
 *
 * @param dec - The permission decorator under test.
 * @param user - The current user, or `null` for anonymous.
 * @param expected - The expected authorization verdict.
 */
async function expectGuard(
  dec: MethodDecorator,
  user: CtxUser | null,
  expected: boolean,
): Promise<void> {
  const meta = metaFor(dec);
  const granted = await runGuard(meta, user);

  expect(granted).toBe(expected);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Permission() metadata', () => {
  it('encodes a PUBLIC resource as public', () => {
    const meta = metaFor(Permission(Resource.PUBLIC));

    expect(meta.mode).toBe(PermissionMode.AND);
    expect(meta.isPublic).toBe(true);
    expect(meta.permissions).toEqual([[Resource.PUBLIC]]);
  });

  it('encodes AUTHENTICATED without an action and not public', () => {
    const meta = metaFor(Permission(Resource.AUTHENTICATED));

    expect(meta.isPublic).toBe(false);
    expect(meta.permissions).toEqual([[Resource.AUTHENTICATED]]);
  });

  it('encodes SELF together with its CanDo callback', () => {
    const meta = metaFor(Permission(Resource.SELF, allow));

    expect(meta.permissions[0][0]).toBe(Resource.SELF);
    expect(meta.permissions[0][1]).toBe(allow);
  });

  it('encodes a scoped resource + action', () => {
    const meta = metaFor(Permission(Resource.USER, Action.DELETE));

    expect(meta.mode).toBe(PermissionMode.AND);
    expect(meta.permissions).toEqual([[Resource.USER, Action.DELETE]]);
  });

  it('combines permissions spread as arguments with OR', () => {
    const meta = metaFor(Permission(
      [Resource.USER, Action.UPDATE],
      [Resource.SELF, allow],
    ));

    expect(meta.mode).toBe(PermissionMode.OR);
    expect(meta.permissions[0]).toEqual([Resource.USER, Action.UPDATE]);
    expect(meta.permissions[1][0]).toBe(Resource.SELF);
    expect(meta.permissions[1][1]).toBe(allow);
  });

  it('combines a single array of permissions with AND', () => {
    const meta = metaFor(Permission([
      [Resource.USER, Action.READ],
      [Resource.PERMISSION, Action.READ],
    ]));

    expect(meta.mode).toBe(PermissionMode.AND);
    expect(meta.permissions).toEqual([
      [Resource.USER, Action.READ],
      [Resource.PERMISSION, Action.READ],
    ]);
  });

  it('marks an OR list containing PUBLIC as public', () => {
    const meta = metaFor(Permission(
      [Resource.PUBLIC],
      [Resource.USER, Action.READ],
    ));

    expect(meta.isPublic).toBe(true);
  });

  it('throws when no permission can be derived', () => {
    expect(() => Permission(undefined as never)).toThrow();
  });
});

describe('Plain() / Paginated() metadata', () => {
  it('Plain forwards a single special resource', () => {
    const meta = metaFor(Plain(DummyDto, Resource.PUBLIC));

    expect(meta.isPublic).toBe(true);
    expect(meta.permissions).toEqual([[Resource.PUBLIC]]);
  });

  it('Plain forwards SELF + CanDo', () => {
    const meta = metaFor(Plain(DummyDto, Resource.SELF, allow));

    expect(meta.permissions[0][0]).toBe(Resource.SELF);
    expect(meta.permissions[0][1]).toBe(allow);
  });

  it('Plain forwards OR permissions', () => {
    const meta = metaFor(Plain(
      DummyDto,
      [Resource.USER, Action.UPDATE],
      [Resource.SELF, allow],
    ));

    expect(meta.mode).toBe(PermissionMode.OR);
    expect(meta.permissions).toHaveLength(2);
  });

  it('Paginated forwards a scoped resource + action', () => {
    const meta = metaFor(Paginated(DummyDto, Resource.USER, Action.LIST));

    expect(meta.permissions).toEqual([[Resource.USER, Action.LIST]]);
  });
});

describe('PermissionGuard — PUBLIC', () => {
  it('allows anonymous requests', async () => {
    await expectGuard(Permission(Resource.PUBLIC), null, true);
  });

  it('allows logged-in requests', async () => {
    await expectGuard(Permission(Resource.PUBLIC), asUser(), true);
  });
});

describe('PermissionGuard — AUTHENTICATED', () => {
  it('allows any logged-in user', async () => {
    await expectGuard(Permission(Resource.AUTHENTICATED), asUser(), true);
  });

  it('denies anonymous requests', async () => {
    await expectGuard(Permission(Resource.AUTHENTICATED), null, false);
  });
});

describe('PermissionGuard — SELF', () => {
  it('allows a logged-in user when the CanDo passes', async () => {
    await expectGuard(Permission(Resource.SELF, allow), asUser(), true);
  });

  it('denies a logged-in user when the CanDo fails', async () => {
    await expectGuard(Permission(Resource.SELF, deny), asUser(), false);
  });

  it('denies anonymous requests regardless of the CanDo', async () => {
    await expectGuard(Permission(Resource.SELF, allow), null, false);
  });

  it('passes the request context manager to the CanDo', async () => {
    const canDo = jest.fn().mockReturnValue(true);
    const meta = metaFor(Permission(Resource.SELF, canDo));

    await runGuard(meta, asUser());

    expect(canDo).toHaveBeenCalledWith(MANAGER);
  });
});

describe('PermissionGuard — scoped resource', () => {
  it('allows when the user holds the scope', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.DELETE])]]);

    await expectGuard(
      Permission(Resource.USER, Action.DELETE),
      asUser({ permissions }),
      true,
    );
  });

  it('denies when the action is missing from the scope', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.READ])]]);

    await expectGuard(
      Permission(Resource.USER, Action.DELETE),
      asUser({ permissions }),
      false,
    );
  });

  it('denies when the user has no permissions at all', async () => {
    await expectGuard(
      Permission(Resource.USER, Action.DELETE),
      asUser(),
      false,
    );
  });

  it('lets an admin bypass the scope check', async () => {
    await expectGuard(
      Permission(Resource.USER, Action.DELETE),
      asUser({ admin: true }),
      true,
    );
  });

  it('narrows a scoped permission by its CanDo', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.UPDATE])]]);

    await expectGuard(
      Permission(Resource.USER, Action.UPDATE, deny),
      asUser({ permissions }),
      false,
    );
  });
});

describe('PermissionGuard — OR / AND combinations', () => {
  const orDecorator = (self: CanDo): MethodDecorator =>
    Permission([Resource.USER, Action.UPDATE], [Resource.SELF, self]);

  it('OR: allows via the self branch when the scope is absent', async () => {
    await expectGuard(orDecorator(allow), asUser(), true);
  });

  it('OR: allows via the scope branch when self fails', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.UPDATE])]]);

    await expectGuard(orDecorator(deny), asUser({ permissions }), true);
  });

  it('OR: denies when neither branch passes', async () => {
    await expectGuard(orDecorator(deny), asUser(), false);
  });

  it('AND: denies when only some permissions are held', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.READ])]]);
    const dec = Permission([
      [Resource.USER, Action.READ],
      [Resource.PERMISSION, Action.READ],
    ]);

    await expectGuard(dec, asUser({ permissions }), false);
  });

  it('AND: allows when every permission is held', async () => {
    const permissions = new Map([
      [Resource.USER, new Set([Action.READ])],
      [Resource.PERMISSION, new Set([Action.READ])],
    ]);
    const dec = Permission([
      [Resource.USER, Action.READ],
      [Resource.PERMISSION, Action.READ],
    ]);

    await expectGuard(dec, asUser({ permissions }), true);
  });
});

describe('PermissionGuard — special resources skip user.permissions', () => {
  const specialCases: Array<[string, MethodDecorator]> = [
    ['PUBLIC', Permission(Resource.PUBLIC)],
    ['AUTHENTICATED', Permission(Resource.AUTHENTICATED)],
    ['SELF', Permission(Resource.SELF, allow)],
  ];

  it.each(specialCases)(
    'never reads user.permissions for %s',
    async (_label, dec) => {
      const permissions: PermissionMap = new Map();
      const getSpy = jest.spyOn(permissions, 'get');
      const meta = metaFor(dec);

      await runGuard(meta, asUser({ permissions }));

      expect(getSpy).not.toHaveBeenCalled();
    },
  );

  it('reads user.permissions for a scoped resource', async () => {
    const permissions = new Map([[Resource.USER, new Set([Action.READ])]]);
    const getSpy = jest.spyOn(permissions, 'get');
    const meta = metaFor(Permission(Resource.USER, Action.READ));

    await runGuard(meta, asUser({ permissions }));

    expect(getSpy).toHaveBeenCalledWith(Resource.USER);
  });
});

describe('AuthPermission — type-level constraints', () => {
  it('rejects invalid shapes at compile time', () => {
    // This block is validated by the TypeScript compiler via ts-jest.
    // Each suppression directive below asserts that the following call is a
    // type error, and the valid calls must compile cleanly. Never executed.
    const assertTypes = (): void => {
      // @ts-expect-error SELF requires a CanDo callback.
      Permission(Resource.SELF);
      // @ts-expect-error SELF cannot be paired with an Action.
      Permission(Resource.SELF, Action.UPDATE);
      // @ts-expect-error PUBLIC cannot be paired with an Action.
      Permission(Resource.PUBLIC, Action.READ);
      // @ts-expect-error AUTHENTICATED cannot be paired with an Action.
      Permission(Resource.AUTHENTICATED, Action.READ);
      // @ts-expect-error Plain: SELF requires a CanDo callback.
      Plain(DummyDto, Resource.SELF);

      Permission(Resource.PUBLIC);
      Permission(Resource.AUTHENTICATED);
      Permission(Resource.SELF, allow);
      Permission(Resource.USER, Action.READ);
      Permission(Resource.USER, Action.READ, allow);
    };

    expect(typeof assertTypes).toBe('function');
  });
});
