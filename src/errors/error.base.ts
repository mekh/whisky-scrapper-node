import { ErrorCodes } from '~enums';

export interface BaseErrorOptions {
  code?: number;

  data?: any;

  /**
   * Whether `data` is part of the answer the client reads rather than a
   * debugging aid. Off by default: most of it names ids nobody asked for.
   */
  expose?: boolean;
}

export class ErrorBase extends Error {
  code?: ErrorCodes;

  data?: unknown;

  expose: boolean;

  constructor(message: string, options?: BaseErrorOptions) {
    super(message);

    this.code = options?.code;
    this.data = options?.data;
    this.expose = options?.expose ?? false;
  }
}
