import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class NotAuthorizedError extends ErrorBase {
  constructor(message = 'Permission denied', data?: unknown) {
    super(message, { code: ErrorCodes.NOT_AUTHORIZED, data });
  }
}
