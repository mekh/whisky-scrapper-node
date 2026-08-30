import 'reflect-metadata';

import { AppConfig, DbConfig, ValkeyConfig, WatchdogConfig } from '~config';

/**
 * `DbConfig` validates itself on construction and requires these three, so
 * they are set for the whole file rather than per case: the validation runs
 * on a `setImmediate`, and clearing them between cases would race it into an
 * unhandled throw.
 */
process.env.DB_NAME = process.env.DB_NAME ?? 'test';
process.env.DB_USER = process.env.DB_USER ?? 'test';
process.env.DB_PASS = process.env.DB_PASS ?? 'test';

/**
 * Every variable these cases touch, cleared around each one so a developer's
 * own environment cannot decide the result.
 */
const VARS = [
  'VALKEY_COMMAND_TIMEOUT_MS',
  'VALKEY_OFFLINE_QUEUE',
  'VALKEY_KEEP_ALIVE_MS',
  'DB_ACQUIRE_TIMEOUT_MS',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  'DB_POOL_SIZE',
  'APP_REQUEST_TIMEOUT_MS',
  'APP_REQUEST_DEADLINE_MS',
  'WATCHDOG_ENABLED',
  'WATCHDOG_INTERVAL_MS',
];

beforeEach(() => {
  VARS.forEach((name) => delete process.env[name]);
});

afterEach(() => {
  VARS.forEach((name) => delete process.env[name]);
});

describe('ValkeyConfig', () => {
  it('bounds every wait by default', () => {
    const config = new ValkeyConfig();

    expect(config.commandTimeoutMs).toBeGreaterThan(0);
    expect(config.connectTimeoutMs).toBeGreaterThan(0);
    expect(config.keepAliveMs).toBeGreaterThan(0);
    expect(config.maxRetriesPerRequest).toBeGreaterThanOrEqual(0);
  });

  it('keeps the offline queue off, so commands fail fast', () => {
    expect(new ValkeyConfig().offlineQueue).toBe(false);
  });

  it('honours an override', () => {
    process.env.VALKEY_COMMAND_TIMEOUT_MS = '500';

    expect(new ValkeyConfig().commandTimeoutMs).toBe(500);
  });
});

describe('DbConfig', () => {
  it('passes the pool and statement bounds to the driver', () => {
    const config = new DbConfig();

    expect(config.extra.connectionTimeoutMillis).toBe(config.acquireTimeoutMs);
    expect(config.extra.statement_timeout).toBe(config.statementTimeoutMs);
    expect(config.extra.idle_in_transaction_session_timeout)
      .toBe(config.idleInTransactionTimeoutMs);
    expect(config.extra.keepAlive).toBe(true);
  });

  it('survives the spread TypeORM applies to it', () => {
    process.env.DB_ACQUIRE_TIMEOUT_MS = '1234';

    const spread = { ...new DbConfig() };

    expect(spread.extra.connectionTimeoutMillis).toBe(1234);
  });
});

describe('AppConfig request bounds', () => {
  it('leaves the socket deadline above the handler budget', () => {
    const config = new AppConfig();

    expect(config.requestDeadlineMs).toBeGreaterThan(config.requestTimeoutMs);
  });

  it('keeps keep-alive above the proxy default of 60 s', () => {
    expect(new AppConfig().keepAliveTimeoutMs).toBeGreaterThan(60000);
  });
});

describe('WatchdogConfig', () => {
  it('is on by default', () => {
    expect(new WatchdogConfig().enabled).toBe(true);
  });

  it('keeps the ping deadline well inside the heartbeat interval', () => {
    const config = new WatchdogConfig();

    expect(config.pingTimeoutMs).toBeLessThan(config.intervalMs);
  });
});
