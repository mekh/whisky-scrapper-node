import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ValidationError, validateOrReject } from 'class-validator';
import { Observable, mergeMap } from 'rxjs';

import { ValidationConfig } from '~config';
import { RESPONSE_VALIDATION_META_INJECT_TOKEN } from '~constants';
import { ServerError } from '~errors';

@Injectable()
export class ValidationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ValidationInterceptor.name);

  public constructor(private readonly reflector: Reflector) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<any> {
    if (!this.isEnabled(context)) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap(
        (data?: object | object[]) => this.validate(data),
      ),
    );
  }

  /**
   * Whether the route wants its response validated. Only an explicit
   * `@ValidateResponse(false)` turns it off, so a route saying nothing keeps
   * the validation it has always had.
   *
   * @param context - The execution context of the current request.
   * @returns True unless the handler or its controller opted out.
   */
  private isEnabled(context: ExecutionContext): boolean {
    const enabled = this.reflector.getAllAndOverride<boolean | undefined>(
      RESPONSE_VALIDATION_META_INJECT_TOKEN,
      [
        context.getHandler(),
        context.getClass(),
      ],
    );

    return enabled ?? true;
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
