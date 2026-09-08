import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class TooManyRequestsError extends ErrorBase {
  constructor(message: string, data?: unknown) {
    super(message, { code: ErrorCodes.TOO_MANY_REQUESTS, data });
  }
}
