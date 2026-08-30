import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class ServiceUnavailableError extends ErrorBase {
  constructor(message: string, data?: unknown) {
    super(message, { code: ErrorCodes.SERVICE_UNAVAILABLE, data });
  }
}
