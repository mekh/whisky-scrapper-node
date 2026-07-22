import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class ServerError extends ErrorBase {
  constructor(message: string, data?: unknown) {
    super(message, { code: ErrorCodes.SERVER_ERROR, data });
  }
}
