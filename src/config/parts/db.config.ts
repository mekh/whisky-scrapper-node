import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { ConfigurationError } from '~/errors';
import { DbQueryLogger } from '~lib/db-logger';

import { BaseConfig } from '../base.config';

/**
 * Connections shared by every instance of the API, before the division.
 *
 * The number that belongs in configuration is the total, not the share: what
 * is fixed is the database's own `max_connections`, a property of the server
 * and not of how many API processes happen to be running. So this is set once
 * against that ceiling and stays put however the deployment is scaled, while
 * the per-instance size is derived at startup.
 */
const DEFAULT_POOL_SIZE_TOTAL = 50;

/**
 * How many instances share the pool when nothing says otherwise.
 */
const DEFAULT_INSTANCES = 1;

/**
 * How long a caller may wait for a connection. The pool applies this to
 * queued waiters as well as to the TCP connect, so it is the setting that
 * decides what happens when the pool is drained: a request fails in seconds
 * with a real error, instead of standing in the queue until the client gives
 * up and the operator is left with an unexplained silence.
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;

/**
 * Ceiling for a single statement. Generous on purpose — the sync writes
 * catalogues of a few thousand rows and must not be cut off — but finite, so
 * a query that will never finish cannot hold a connection forever.
 */
const DEFAULT_STATEMENT_TIMEOUT_MS = 60000;

/**
 * Ceiling for a transaction that is open but doing nothing. Every transaction
 * in this codebase does database work between its statements, so idling for
 * two minutes means the owner is stuck; releasing its locks is then strictly
 * better than holding them.
 */
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 120000;

const KEEP_ALIVE_INITIAL_DELAY_MS = 10000;

export class DbConfig extends BaseConfig {
  public readonly type = 'postgres';

  public readonly autoLoadEntities = true;

  public readonly keepConnectionAlive = true;

  /**
   * How many instances of the API share the pool. Under an orchestrator this
   * is the replica count, and it must be set from whatever declares that
   * count so the two cannot drift apart.
   */
  @IsInt()
  @IsPositive()
  public readonly instances = this.asNumber('APP_INSTANCES')
    ?? DEFAULT_INSTANCES;

  @IsInt()
  @IsPositive()
  public readonly poolSizeTotal = this.asNumber('DB_POOL_SIZE_TOTAL')
    ?? DEFAULT_POOL_SIZE_TOTAL;

  /**
   * This instance's share. Declared after the two fields it divides, because
   * class fields initialise in declaration order.
   */
  @IsInt()
  @IsPositive()
  public readonly poolSize = this.derivePoolSize();

  @IsInt()
  @IsPositive()
  public readonly maxQueryExecutionTime = this.asNumber('DB_SLOW_QUERY_MS') ??
    100;

  @IsString()
  public readonly database = this.asString('DB_NAME');

  @IsString()
  public readonly host = this.asString('DB_HOST') ?? 'localhost';

  @IsInt()
  @IsPositive()
  @Max(2 ** 16 - 1)
  @IsOptional()
  public readonly port = this.asNumber('DB_PORT');

  @IsString()
  public readonly username = this.asString('DB_USER');

  @IsString()
  public readonly password = this.asString('DB_PASS');

  @IsBoolean()
  public readonly logging = this.asBoolean('DB_LOGGING') ?? false;

  /**
   * Whether a logged statement carries its bound parameters. Off in
   * production, where those values are user data — see
   * {@link DbQueryLogger} for why the flag has to exist at all.
   */
  @IsBoolean()
  public readonly logParameters = this.asBoolean('DB_LOG_PARAMETERS')
    ?? false;

  @IsInt()
  @IsPositive()
  @IsOptional()
  public readonly retryAttempts = this.asNumber('DB_RETRY_ATTEMPTS');

  @IsInt()
  @IsPositive()
  @IsOptional()
  public readonly retryDelay = this.asNumber('DB_RETRY_DELAY');

  @IsInt()
  @Min(0)
  public readonly acquireTimeoutMs = this.asNumber('DB_ACQUIRE_TIMEOUT_MS')
    ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

  @IsInt()
  @Min(0)
  public readonly statementTimeoutMs = this.asNumber('DB_STATEMENT_TIMEOUT_MS')
    ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  @IsInt()
  @Min(0)
  public readonly idleInTransactionTimeoutMs =
    this.asNumber('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS')
      ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;

  /**
   * Driver options TypeORM forwards verbatim to `pg`. Declared as a field
   * rather than a getter because the whole config object is spread into the
   * TypeORM options, and a spread copies own properties only.
   *
   * `keepAlive` is the quiet one worth naming: without it a connection whose
   * peer vanished without closing stays usable-looking forever, and the first
   * query written to it waits forever too. Every value here is a zero-means-
   * disabled passthrough of the `pg` and PostgreSQL semantics.
   */
  public readonly extra = {
    connectionTimeoutMillis: this.acquireTimeoutMs,
    statement_timeout: this.statementTimeoutMs,
    idle_in_transaction_session_timeout: this.idleInTransactionTimeoutMs,
    query_timeout: this.statementTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEP_ALIVE_INITIAL_DELAY_MS,
  };

  /**
   * The ORM's own logger. A field for the same reason {@link extra} is one:
   * the config object is spread into the TypeORM options.
   *
   * Declared last because a class field initializer runs in declaration
   * order and this one reads two fields above it. Supplying a logger at all
   * is what keeps query parameters out of the log — see
   * {@link DbQueryLogger}, which documents the TypeORM behaviour that makes
   * it necessary.
   */
  public readonly logger = new DbQueryLogger(this.logging, this.logParameters);

  /**
   * Divides the shared pool by the number of instances sharing it.
   *
   * Both failures are loud rather than silent, because both produce a working
   * process that is quietly wrong: a leftover `DB_POOL_SIZE` would be ignored
   * while the operator believes it applies, and a total smaller than the
   * instance count would leave a pool of zero, which fails later as a
   * connection timeout on every request rather than at boot.
   *
   * @returns This instance's share of the pool.
   */
  private derivePoolSize(): number {
    if (this.nonEmpty('DB_POOL_SIZE') !== undefined) {
      throw new ConfigurationError(
        'DB_POOL_SIZE is no longer read: it has been replaced by '
          + 'DB_POOL_SIZE_TOTAL, the pool shared across every instance and '
          + 'divided by APP_INSTANCES at startup. Remove DB_POOL_SIZE and set '
          + 'DB_POOL_SIZE_TOTAL to what the database can serve in total.',
      );
    }

    const share = Math.floor(this.poolSizeTotal / this.instances);

    if (share < 1) {
      throw new ConfigurationError(
        `DB_POOL_SIZE_TOTAL (${this.poolSizeTotal}) is smaller than `
          + `APP_INSTANCES (${this.instances}), which leaves this instance no `
          + 'connections at all.',
      );
    }

    return share;
  }
}
