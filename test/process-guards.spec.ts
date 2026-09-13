import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { registerProcessGuards } from '~app/process';

/**
 * The two events the guards attach to.
 */
const EVENTS = ['unhandledRejection', 'uncaughtException'] as const;

/**
 * `process` typed as the plain emitter it is. Its own declarations narrow
 * these three methods to `Signals`, which neither event here is.
 */
const emitter = process as NodeJS.EventEmitter;

/**
 * Exactly what the emitter accepts back, so a saved listener re-registers
 * without a cast.
 */
type Listener = Parameters<NodeJS.EventEmitter['on']>[1];

describe('process guards', () => {
  let calls: unknown[][];
  let spy: jest.SpyInstance;
  let existing: Record<string, Listener[]>;

  beforeEach(() => {
    calls = [];
    spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]): void => {
        calls.push(args);
      });

    /**
     * Jest installs its own handlers for both events; they are taken off for
     * the duration of a case so a deliberate emit is answered only by the
     * guards, and put back afterwards.
     */
    existing = {};

    EVENTS.forEach((event) => {
      existing[event] = emitter.listeners(event) as Listener[];
      emitter.removeAllListeners(event);
    });
  });

  afterEach(() => {
    EVENTS.forEach((event) => {
      emitter.removeAllListeners(event);
      existing[event]?.forEach((listener) => {
        emitter.on(event, listener);
      });
    });

    spy.mockRestore();
  });

  it('survives a rejection nobody awaited, and logs it', () => {
    const error = new Error('timeout exceeded when trying to connect');

    registerProcessGuards();

    expect(() => process.emit('unhandledRejection', error, Promise.resolve()))
      .not.toThrow();

    expect(calls).toContainEqual([error]);
  });

  it('survives an uncaught exception, and logs it', () => {
    const error = new Error('synchronous escape');

    registerProcessGuards();

    expect(() => process.emit('uncaughtException', error)).not.toThrow();

    expect(calls).toContainEqual([error]);
  });

  /**
   * The error must reach the logger as the sole argument. Interpolated into
   * the message instead, it would arrive as a format argument rather than as
   * pino's `err`, and the `err.parameters` / `err.driverError.detail`
   * redaction paths would no longer cover a failed query's bound values.
   */
  it('logs the error alone, so the redaction paths still reach it', () => {
    const error = new Error('boom');

    registerProcessGuards();
    process.emit('uncaughtException', error);

    const carrying = calls.filter((args) => args.includes(error));

    expect(carrying).toEqual([[error]]);
  });

  it('names which hook caught it, so the two are told apart', () => {
    registerProcessGuards();

    process.emit('unhandledRejection', new Error('a'), Promise.resolve());
    process.emit('uncaughtException', new Error('b'));

    const kinds = calls
      .filter((args) => args.length > 1)
      .map((args) => args[1]);

    expect(kinds).toEqual([
      'Unhandled promise rejection',
      'Uncaught exception',
    ]);
  });
});
