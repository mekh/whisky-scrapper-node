import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ValidationError, validateOrReject } from 'class-validator';
import { Observable, mergeMap } from 'rxjs';

import { ValidationConfig } from '~config';
import { ServerError } from '~errors';

@Injectable()
export class ValidationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ValidationInterceptor.name);

  public intercept(
    _: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    return next.handle().pipe(
      mergeMap(
        (data?: object | object[]) => this.validate(data),
      ),
    );
  }

  private async validate(data?: object | object[]): Promise<unknown> {
    if (!data) {
      this.logger.verbose('no data to validate');

      return data;
    }

    this.logger.verbose('validating outgoing data: %o', data);

    const toCheck = Array.isArray(data) ? data : [data];

    return Promise
      .all(
        toCheck.map(
          (item: object) => validateOrReject(item, { whitelist: true }),
        ),
      )
      .then(() => data)
      .catch((errors: ValidationError[]) => {
        const details = ValidationConfig.parseValidationErrors(errors);

        this.logger.verbose('validation failed: %s', details);
        throw new ServerError('Outgoing validation failed', { details });
      });
  }
}
