import {
  ArgumentsHost,
  Catch,
  ExceptionFilter as IExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ServerError } from '~errors';

import { ErrorBase } from '~errors/error.base';

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

    this.httpAdapterHost.httpAdapter.reply(
      ctx.getResponse(),
      this.getResponse(error),
      status,
    );
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
