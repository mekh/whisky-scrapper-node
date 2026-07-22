import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { ServerError } from '~errors';
import { Request } from '~interfaces';

@Injectable()
export class LogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LogInterceptor.name);

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<object> {
    const start = Date.now();

    const data = this.getData(context);

    this.logger.debug('incoming req data - %o', data);

    return next.handle().pipe(
      tap((response) => {
        const time = Date.now() - start;
        this.logger.debug('processing time - %dms', time);
        this.logger.verbose('sending response - %o', response ?? {});
      }),
    );
  }

  public getData(context: ExecutionContext): any {
    const type = context.getType();

    switch (type) {
      case 'http':
        return this.getHttpData(context);
      default:
        this.logger.debug('error: unknown context type %s', type);
        throw new ServerError(`Unknown context type: ${type}`);
    }
  }

  public getHttpData(context: ExecutionContext): any {
    this.logger.verbose('extracting http request data');
    const { body, query, params, url, method } = context.switchToHttp()
      .getRequest<Request>();

    return { body, query, params, url, method };
  }
}
