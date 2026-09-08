import {
  ArgumentsHost,
  Catch,
  ExceptionFilter as IExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { HEADER_RATE_LIMIT_RETRY_MS, HEADER_RETRY_AFTER } from '~constants';
import { ServerError, TooManyRequestsError } from '~errors';
import type { Response } from '~types';

import { ErrorBase } from '~errors/error.base';

/**
 * Milliseconds in a second, for rendering `Retry-After` in the whole seconds
 * RFC 9110 requires of it.
 */
const MS_PER_SEC = 1000;

@Catch()
export class ExceptionFilter implements IExceptionFilter {
  protected readonly logger = new Logger(ExceptionFilter.name);

  public constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  public catch(error: any, host: ArgumentsHost): any {
    const isKnownError = error instanceof ErrorBase;
    const isServerError = error instanceof ServerError;
    const isHttpError = error instanceof HttpException;

    const shouldLog = isServerError || !(isKnownError || isHttpError);

    if (shouldLog) {
      this.logger.error(error);
    } else {
      this.logger.verbose(error);
    }

    const status: number = error instanceof HttpException
      ? error.getStatus()
      : (isKnownError ? error.code : HttpStatus.INTERNAL_SERVER_ERROR)
        ?? HttpStatus.INTERNAL_SERVER_ERROR;

    switch (host.getType()) {
      case 'http':
        return this.handleHttp(error, host, status);
      default:
        return error;
    }
  }

  handleHttp(error: unknown, host: ArgumentsHost, status: number): void {
    const ctx = host.switchToHttp();

    this.setRetryAfter(error, ctx.getResponse<Response>());

    this.httpAdapterHost.httpAdapter.reply(
      ctx.getResponse(),
      this.getResponse(error),
      status,
    );
  }

  /**
   * States the wait on a refusal that knows one.
   *
   * `UserRateLimitGuard` sets these headers itself before it throws, but the
   * login ladder is not a guard — it refuses from inside the service, where
   * there is no reply to write to — so this is what makes a `429` carry its
   * delay wherever it was raised. The values are the same either way, so
   * re-setting them for the guard's own refusal changes nothing.
   *
   * @param error - The error being answered.
   * @param reply - The reply being built.
   */
  private setRetryAfter(error: unknown, reply: Response): void {
    if (!(error instanceof TooManyRequestsError)) {
      return;
    }

    const { retryAfterMs } = error.data as { retryAfterMs?: number } ?? {};

    if (!retryAfterMs || retryAfterMs <= 0) {
      return;
    }

    reply.header(
      HEADER_RETRY_AFTER,
      Math.max(1, Math.ceil(retryAfterMs / MS_PER_SEC)),
    );
    reply.header(HEADER_RATE_LIMIT_RETRY_MS, retryAfterMs);
  }

  private getResponse(error: unknown): string | object {
    if (error instanceof HttpException) {
      return error.getResponse();
    }

    if (error instanceof ErrorBase) {
      return error.message;
    }

    return 'Internal Server Error';
  }
}
