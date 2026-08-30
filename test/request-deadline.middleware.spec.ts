import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { RequestDeadlineMiddleware } from '~app/middleware';
import { AppConfig } from '~config';

/**
 * A request stub that records the socket deadlines set on it and can fire the
 * one that is armed.
 */
interface RequestStub {
  /**
   * The stub, typed as the middleware expects it.
   */
  request: IncomingMessage;

  /**
   * Every `setTimeout` call made on the request, in order.
   */
  deadlines: number[];

  /**
   * Fires the armed deadline callback, as the socket would.
   */
  fire: () => void;

  /**
   * Whether the request was destroyed.
   */
  destroyed: () => boolean;
}

/**
 * Builds the request stub.
 *
 * @returns The stub and its controls.
 */
function makeRequest(): RequestStub {
  const deadlines: number[] = [];
  let armed: (() => void) | undefined;
  let destroyed = false;

  const request = {
    method: 'GET',
    url: '/auth/me',
    setTimeout: (ms: number, callback?: () => void): unknown => {
      deadlines.push(ms);

      if (callback) {
        armed = callback;
      }

      return request;
    },
    destroy: (): void => {
      destroyed = true;
    },
  } as unknown as IncomingMessage;

  return {
    request,
    deadlines,
    fire: (): void => armed?.(),
    destroyed: (): boolean => destroyed,
  };
}

describe('RequestDeadlineMiddleware', () => {
  const config = { requestDeadlineMs: 45000 } as AppConfig;

  it('arms the deadline and continues the chain', () => {
    const { request, deadlines } = makeRequest();
    const response = new EventEmitter() as ServerResponse;
    const next = jest.fn();

    new RequestDeadlineMiddleware(config).use(request, response, next);

    expect(deadlines).toEqual([45000]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lifts the deadline once the response is finished', () => {
    const { request, deadlines } = makeRequest();
    const response = new EventEmitter() as ServerResponse;

    new RequestDeadlineMiddleware(config).use(request, response, jest.fn());
    response.emit('finish');

    expect(deadlines).toEqual([45000, 0]);
  });

  it('destroys and reports a request that never got a handler', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { request, fire, destroyed } = makeRequest();
    const response = new EventEmitter() as ServerResponse;

    new RequestDeadlineMiddleware(config).use(request, response, jest.fn());
    fire();

    expect(destroyed()).toBe(true);
    expect(String(error.mock.calls[0]?.[0])).toContain('deadline');
    expect(error.mock.calls[0]).toContain('/auth/me');

    error.mockRestore();
  });

  it('is inert when the deadline is zero', () => {
    const { request, deadlines } = makeRequest();
    const response = new EventEmitter() as ServerResponse;
    const next = jest.fn();
    const off = { requestDeadlineMs: 0 } as AppConfig;

    new RequestDeadlineMiddleware(off).use(request, response, next);

    expect(deadlines).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
