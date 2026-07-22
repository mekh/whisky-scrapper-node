import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class NotAuthenticatedError extends ErrorBase {
  constructor(message = 'Not authenticated', data?: unknown) {
    super(message, { code: ErrorCodes.NOT_AUTHENTICATED, data });
  }
}
