import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError, timeout } from 'rxjs';

import { AppConfig } from '~config';
import { ServiceUnavailableError } from '~errors';
import { Request } from '~interfaces';

/**
 * Fails a request that has outstayed its budget instead of letting it hang.
 *
 * A request with no deadline is a request that can hold a socket forever, and
 * a few of those are enough to make an API look dead from the outside while
 * the process itself is idle — which is exactly how the 2026-08-30 outage
 * presented. A `503` is a worse answer than a result and a much better one
 * than silence: the client learns immediately, the proxy stops holding the
 * connection, and the log gains a line naming the route that stalled.
 *
 * Registered first among the global interceptors so its clock covers every
 * other one, the handler, and serialization.
 *
 * What it deliberately does **not** cover: guards, which Nest runs before any
 * interceptor. A stall there is caught by the server's own socket timeout
 * (`APP_CONNECTION_TIMEOUT_MS`) and, at the source, by the per-command
 * timeouts on Valkey and PostgreSQL.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimeoutInterceptor.name);

  public constructor(private readonly config: AppConfig) {}

  /**
   * Applies the request budget to the handler chain.
   *
   * @param context - The execution context of the current request.
   * @param next - The rest of the chain.
   * @returns The handler's stream, failed with `503` once the budget is spent.
   */
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const budgetMs = this.config.requestTimeoutMs;

    if (budgetMs <= 0) {
      return next.handle();
    }

    return next.handle().pipe(
      timeout({
        each: budgetMs,
        with: () => throwError(() => this.expired(context, budgetMs)),
      }),
    );
  }

  /**
   * Builds the error a timed-out request fails with, logging what stalled.
   *
   * @param context - The execution context of the timed-out request.
   * @param budgetMs - The budget it exceeded.
   * @returns The error to fail the request with.
   */
  private expired(
    context: ExecutionContext,
    budgetMs: number,
  ): ServiceUnavailableError {
    const route = this.describe(context);

    this.logger.error(
      'Request timed out after %d ms: %s',
      budgetMs,
      route,
    );

    return new ServiceUnavailableError(
      'The request took too long and was aborted',
      { route, budgetMs },
    );
  }

  /**
   * Names the request for the log line.
   *
   * @param context - The execution context of the current request.
   * @returns A `METHOD /url` fragment, or the context type when it is not an
   *   HTTP request.
   */
  private describe(context: ExecutionContext): string {
    if (context.getType() !== 'http') {
      return context.getType();
    }

    const request = context.switchToHttp().getRequest<Request>();

    return `${request.method} ${request.url}`;
  }
}
