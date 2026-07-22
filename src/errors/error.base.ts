import { ErrorCodes } from '~enums';

export interface BaseErrorOptions {
  code?: number;
  data?: any;
}

export class ErrorBase extends Error {
  code?: ErrorCodes;

  data?: unknown;

  constructor(message: string, options?: BaseErrorOptions) {
    super(message);

    this.code = options?.code;
    this.data = options?.data;
  }
}
