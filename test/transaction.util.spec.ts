import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { runOnTransactionCommit } from 'typeorm-transactional';

import { TransactionUtils } from '~utils';

jest.mock('typeorm-transactional', () => ({
  runOnTransactionCommit: jest.fn(),
}));

const registerHook = runOnTransactionCommit as jest.MockedFunction<
  typeof runOnTransactionCommit
>;

describe('TransactionUtils.afterCommit', () => {
  beforeEach(() => {
    registerHook.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defers the callback until the transaction commits', () => {
    let hook: (() => void) | null = null;

    registerHook.mockImplementation((callback: () => void) => {
      hook = callback;
    });

    const effect = jest.fn();

    TransactionUtils.afterCommit(effect);

    expect(effect).not.toHaveBeenCalled();

    (hook as unknown as () => void)();

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('runs the callback at once outside a transaction', () => {
    /**
     * What the library actually throws when nothing opened a transactional
     * context — the case every autocommit writer is in.
     */
    registerHook.mockImplementation(() => {
      throw new Error('No hook manager found in context.');
    });

    const effect = jest.fn();

    TransactionUtils.afterCommit(effect);

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('runs the callback at once when the module is mocked away', () => {
    /**
     * Several service specs mock `typeorm-transactional` down to
     * `{ Transactional }`, which leaves this import undefined. Calling it
     * throws a `TypeError`, and the fallback has to treat that like a
     * missing context or every one of those specs breaks.
     */
    registerHook.mockImplementation(() => {
      throw new TypeError('runOnTransactionCommit is not a function');
    });

    const effect = jest.fn();

    TransactionUtils.afterCommit(effect);

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing callback escape the immediate path', () => {
    registerHook.mockImplementation(() => {
      throw new Error('No hook manager found in context.');
    });

    expect(() => {
      TransactionUtils.afterCommit(() => {
        throw new Error('side effect failed');
      });
    }).not.toThrow();
  });

  it('never lets a failing callback escape the deferred path', () => {
    let hook: (() => void) | null = null;

    registerHook.mockImplementation((callback: () => void) => {
      hook = callback;
    });

    TransactionUtils.afterCommit(() => {
      throw new Error('side effect failed');
    });

    /**
     * The library fires this from a `setImmediate`, where a throw would be
     * an uncaught exception rather than a rejected promise.
     */
    expect(() => {
      (hook as unknown as () => void)();
    }).not.toThrow();
  });
});
