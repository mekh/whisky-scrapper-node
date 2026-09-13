import 'reflect-metadata';

import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IsString } from 'class-validator';
import { Observable, firstValueFrom, of } from 'rxjs';

import { ValidationInterceptor } from '~app/interceptors';
import { ValidateResponse } from '~decorators/http';
import { ServerError } from '~errors';

/**
 * A response type with one validated field, so a wrong value is rejected and
 * an undeclared one is whitelisted away.
 */
class Row {
  @IsString()
  public name!: string;
}

/**
 * A controller stating nothing, which must keep the validation every route
 * has always had.
 */
class SilentRoutes {
  /**
   * A handler carrying no flag of its own.
   */
  public handler(): void {}
}

/**
 * A controller opting out wholesale, with one handler opting back in.
 */
@ValidateResponse(false)
class OptedOutRoutes {
  /**
   * A handler inheriting the controller's opt-out.
   */
  public handler(): void {}

  /**
   * A handler overriding it.
   */
  @ValidateResponse()
  public strict(): void {}
}

/**
 * A controller validating explicitly, with one handler opting out.
 */
@ValidateResponse()
class ValidatedRoutes {
  /**
   * A handler overriding its controller the other way round.
   */
  @ValidateResponse(false)
  public lax(): void {}
}

/**
 * Builds the interceptor with a real reflector, so the decorator under test
 * is read exactly as Nest reads it.
 *
 * @returns The interceptor.
 */
function build(): ValidationInterceptor {
  return new ValidationInterceptor(new Reflector());
}

/**
 * An execution context pointing at one handler of one controller.
 *
 * @param cls - The controller class.
 * @param method - The handler's name on its prototype.
 * @returns The context stub.
 */
function context(cls: object, method: string): ExecutionContext {
  const proto = (cls as { prototype: Record<string, unknown> }).prototype;

  return {
    getHandler: (): unknown => proto[method],
    getClass: (): unknown => cls,
  } as unknown as ExecutionContext;
}

/**
 * A handler answering with the given payload.
 *
 * @param data - What the handler returns.
 * @returns The call handler stub.
 */
function handler(data: unknown): CallHandler {
  return {
    handle: (): Observable<unknown> => of(data),
  };
}

/**
 * A row carrying one valid field and one the DTO never declared.
 *
 * @param name - The validated field's value.
 * @returns The populated instance.
 */
function row(name: unknown): Row {
  return Object.assign(new Row(), { name, secret: 'leaked' });
}

describe('ValidationInterceptor — a route stating nothing', () => {
  it('passes a valid response through', async () => {
    const result = await firstValueFrom(
      build().intercept(
        context(SilentRoutes, 'handler'),
        handler(row('ok')),
      ),
    );

    expect(result).toEqual({ name: 'ok' });
  });

  it('fails an invalid response with a server error', async () => {
    const attempt = firstValueFrom(
      build().intercept(
        context(SilentRoutes, 'handler'),
        handler(row(42)),
      ),
    );

    await expect(attempt).rejects.toBeInstanceOf(ServerError);
  });

  it('strips a property the response type never declared', async () => {
    const result = await firstValueFrom(
      build().intercept(
        context(SilentRoutes, 'handler'),
        handler(row('ok')),
      ),
    );

    expect(result).not.toHaveProperty('secret');
  });
});

describe('ValidationInterceptor — a route opting out', () => {
  it('lets an invalid response through untouched', async () => {
    const result = await firstValueFrom(
      build().intercept(
        context(OptedOutRoutes, 'handler'),
        handler(row(42)),
      ),
    );

    expect(result).toEqual({ name: 42, secret: 'leaked' });
  });

  it('keeps a property validation would have stripped', async () => {
    const result = await firstValueFrom(
      build().intercept(
        context(OptedOutRoutes, 'handler'),
        handler(row('ok')),
      ),
    );

    expect(result).toHaveProperty('secret', 'leaked');
  });
});

describe('ValidationInterceptor — the handler outranks its controller', () => {
  it('validates a handler that opts back in', async () => {
    const attempt = firstValueFrom(
      build().intercept(
        context(OptedOutRoutes, 'strict'),
        handler(row(42)),
      ),
    );

    await expect(attempt).rejects.toBeInstanceOf(ServerError);
  });

  it('skips a handler opting out inside a validated class', async () => {
    const result = await firstValueFrom(
      build().intercept(
        context(ValidatedRoutes, 'lax'),
        handler(row(42)),
      ),
    );

    expect(result).toEqual({ name: 42, secret: 'leaked' });
  });
});
