import { ErrorCodes } from '~enums';

import { ErrorBase } from './error.base';

export class DuplicateError extends ErrorBase {
  constructor(message = 'Duplicated', data?: unknown) {
    super(message, { code: ErrorCodes.DUPLICATE, data });
  }
}
