import 'reflect-metadata';

import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { Observable, firstValueFrom, of } from 'rxjs';
import { delay } from 'rxjs/operators';

import { TimeoutInterceptor } from '~app/interceptors';
import { AppConfig } from '~config';
import { ServiceUnavailableError } from '~errors';

/**
 * Builds an interceptor with the given request budget.
 *
 * @param requestTimeoutMs - The budget under test.
 * @returns The interceptor.
 */
function build(requestTimeoutMs: number): TimeoutInterceptor {
  return new TimeoutInterceptor({ requestTimeoutMs } as AppConfig);
}

/**
 * A minimal HTTP execution context.
 *
 * @returns The context stub.
 */
function context(): ExecutionContext {
  return {
    getType: (): string => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/report/catalog' }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * A handler that answers after the given delay.
 *
 * @param ms - How long the handler takes.
 * @returns The call handler stub.
 */
function handler(ms: number): CallHandler {
  return {
    handle: (): Observable<unknown> => of({ ok: true }).pipe(delay(ms)),
  };
}

describe('TimeoutInterceptor', () => {
  it('passes a response that arrives in time straight through', async () => {
    const result = await firstValueFrom(
      build(200).intercept(context(), handler(1)),
    );

    expect(result).toEqual({ ok: true });
  });

  it('fails a request that outstays its budget with 503', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const attempt = firstValueFrom(
      build(20).intercept(context(), handler(200)),
    );

    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 503 });

    expect(String(error.mock.calls[0]?.[0])).toContain('timed out');

    error.mockRestore();
  });

  it('names the route it killed', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await firstValueFrom(build(20).intercept(context(), handler(200)))
      .catch(() => undefined);

    expect(error.mock.calls[0]).toContain('GET /report/catalog');

    error.mockRestore();
  });

  it('is inert when the budget is zero', async () => {
    const result = await firstValueFrom(
      build(0).intercept(context(), handler(30)),
    );

    expect(result).toEqual({ ok: true });
  });
});
