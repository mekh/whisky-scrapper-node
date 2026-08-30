import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppConfig } from '~config';

/**
 * Puts a hard deadline on every request, at the only place that runs before
 * the guards.
 *
 * `TimeoutInterceptor` bounds the handler chain, but Nest runs guards ahead of
 * every interceptor, so a request that stalls in a guard is outside its reach.
 * That is not a hypothetical gap: on 2026-08-30 the API stalled in exactly
 * that spot — the session lookup in `AuthJwtGuard` stopped returning — and
 * every request sat there, unlogged and unanswered, until the proxy gave up.
 * Middleware is the earliest hook Nest offers, which makes it the only place
 * that can bound that window.
 *
 * The deadline lives on the request's own socket and is lifted as soon as the
 * response completes, so an idle keep-alive connection is never touched by
 * it — reaping those is what turns a proxy's pooled connection into a
 * spurious `502`.
 */
@Injectable()
export class RequestDeadlineMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestDeadlineMiddleware.name);

  public constructor(private readonly config: AppConfig) {}

  /**
   * Arms the deadline for this request and hands over to the next handler.
   *
   * @param request - The incoming request.
   * @param response - The response being built for it.
   * @param next - The next handler in the chain.
   */
  public use(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void {
    const deadlineMs = this.config.requestDeadlineMs;

    if (deadlineMs <= 0) {
      next();

      return;
    }

    request.setTimeout(deadlineMs, () => {
      this.abort(request);
    });

    response.on('finish', () => {
      request.setTimeout(0);
    });

    next();
  }

  /**
   * Destroys a request that outlived its deadline, and — the part that
   * matters most — writes the line saying it happened. A request killed here
   * got no further than the guards, so nothing else in the application will
   * ever mention it.
   *
   * @param request - The request that ran out of time.
   */
  private abort(request: IncomingMessage): void {
    this.logger.error(
      'Request exceeded its deadline of %d ms before reaching a handler, '
        + 'socket destroyed: %s %s',
      this.config.requestDeadlineMs,
      request.method,
      request.url,
    );

    request.destroy();
  }
}
