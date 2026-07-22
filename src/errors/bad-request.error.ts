import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class BadRequestError extends ErrorBase {
  constructor(message: string, data?: unknown) {
    super(message, { code: ErrorCodes.BAD_REQUEST, data });
  }
}
