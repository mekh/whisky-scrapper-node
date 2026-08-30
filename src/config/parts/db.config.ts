import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { BaseConfig } from '../base.config';

const DEFAULT_POOL_SIZE = 10;

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

  @IsInt()
  @IsPositive()
  public readonly poolSize = this.asNumber('DB_POOL_SIZE')
    ?? DEFAULT_POOL_SIZE;

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
}
