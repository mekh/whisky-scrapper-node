import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class NotFoundError extends ErrorBase {
  constructor(message = 'Not found', data?: unknown) {
    super(message, { code: ErrorCodes.NOT_FOUND, data });
  }
}
