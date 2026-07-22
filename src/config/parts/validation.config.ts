import { Injectable, ValidationPipeOptions } from '@nestjs/common';
import { ValidationError, ValidatorOptions } from 'class-validator';

import { BadRequestError } from '~errors';

@Injectable()
export class ValidationConfig {
  public static parseValidationErrors(errors: ValidationError[]): string {
    const parseOne = (error: ValidationError, parentPath = ''): string => {
      const { property, children, constraints, target } = error;
      const msg = Object.values(constraints ?? {}).join('; ');

      if (!children?.length) {
        return parentPath ? `${parentPath}: ${msg}` : msg;
      }

      const targetIsArray = Array.isArray(target);
      const childPath = targetIsArray ? `[${property}]` : property;
      const pathDelim = targetIsArray ? '' : '.';
      const path = parentPath
        ? `${parentPath}${pathDelim}${childPath}`
        : childPath;

      const childrenMsg = children.map(
        (child: ValidationError) => parseOne(child, path),
      ).join('; ');

      return [msg, childrenMsg].filter(Boolean).join('; ');
    };

    return errors.map((error) => parseOne(error)).join('; ');
  }

  public static readonly validatorOptions: ValidatorOptions = {
    whitelist: true,
    forbidUnknownValues: true,
    forbidNonWhitelisted: true,
  };

  public readonly validatorOptions = ValidationConfig.validatorOptions;

  public readonly validationPipeOptions: ValidationPipeOptions = {
    ...this.validatorOptions,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) => {
      const msg = ValidationConfig.parseValidationErrors(errors);

      throw new BadRequestError(msg);
    },
    transformOptions: {
      exposeUnsetFields: false,
    },
  };
}
