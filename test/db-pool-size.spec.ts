import 'reflect-metadata';

import { DbConfig } from '~config';
import { ConfigurationError } from '~errors';

/**
 * Builds a config against an environment, leaving `process.env` alone.
 *
 * @param env - The variables to apply on top of the required ones.
 * @returns The constructed config.
 */
function build(env: Record<string, string>): DbConfig {
  const previous = process.env;

  process.env = {
    DB_NAME: 'db',
    DB_HOST: 'localhost',
    DB_USER: 'user',
    DB_PASS: 'pass',
    ...env,
  };

  try {
    return new DbConfig();
  } finally {
    process.env = previous;
  }
}

describe('the pool is configured as a total and divided at startup', () => {
  /**
   * `BaseConfig` schedules its validation with `setImmediate` from the
   * constructor — before the subclass field initializers have run — so a
   * field that throws leaves a validation queued against a half-built object.
   * Fake timers keep that off these cases, which are about the arithmetic.
   */
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('gives one instance the whole total', () => {
    expect(build({ DB_POOL_SIZE_TOTAL: '50' }).poolSize).toBe(50);
  });

  it('divides the total between the instances sharing it', () => {
    expect(build({ DB_POOL_SIZE_TOTAL: '50', APP_INSTANCES: '4' }).poolSize)
      .toBe(12);
  });

  /**
   * Rounding down is what keeps the sum under the database's ceiling: four
   * instances of 12 is 48 against a total of 50, where rounding up would be
   * 52 and two of them would fail to connect.
   */
  it('rounds down, so the instances never sum past the total', () => {
    const config = build({ DB_POOL_SIZE_TOTAL: '50', APP_INSTANCES: '3' });

    expect(config.poolSize).toBe(16);
    expect(config.poolSize * config.instances).toBeLessThanOrEqual(50);
  });

  it('falls back to a default total when nothing is configured', () => {
    expect(build({}).poolSize).toBe(50);
  });

  /**
   * An empty value is how compose forwards a variable the host `.env` omits,
   * so it must read as unset rather than as a configured zero.
   */
  it('treats an empty total as unset', () => {
    expect(build({ DB_POOL_SIZE_TOTAL: '' }).poolSize).toBe(50);
  });

  it('refuses a total that leaves an instance no connections', () => {
    expect(() => build({ DB_POOL_SIZE_TOTAL: '3', APP_INSTANCES: '4' }))
      .toThrow(ConfigurationError);
  });

  /**
   * The renamed variable fails the boot instead of being ignored: a process
   * that silently halves its pool while the operator believes the old value
   * applies is the worse outcome.
   */
  it('refuses to start when the superseded DB_POOL_SIZE is still set', () => {
    expect(() => build({ DB_POOL_SIZE: '10' }))
      .toThrow(/DB_POOL_SIZE_TOTAL/);
  });

  it('ignores an empty DB_POOL_SIZE, which compose forwards when unset', () => {
    expect(build({ DB_POOL_SIZE: '', DB_POOL_SIZE_TOTAL: '20' }).poolSize)
      .toBe(20);
  });
});
