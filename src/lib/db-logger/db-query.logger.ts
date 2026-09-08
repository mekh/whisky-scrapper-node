import { Logger as NestLogger } from '@nestjs/common';
import type { LogLevel, LogMessage, LoggerOptions, QueryRunner } from 'typeorm';
import { AbstractLogger } from 'typeorm';

/**
 * TypeORM logger that routes the ORM's own events into the application
 * logger and, by default, keeps query **parameters** out of them.
 *
 * It exists because of one line in TypeORM's `AbstractLogger`:
 * `isLogEnabledFor('query-slow')` returns `true` unconditionally, so a query
 * slower than `DB_SLOW_QUERY_MS` is logged whatever `DB_LOGGING` says — and
 * the default console logger appends `-- PARAMETERS: [...]` to it. Every
 * bound value of that statement therefore reaches stdout: a tasting note, an
 * email, a freshly hashed password. Redaction cannot help there, because the
 * values are already part of the message string by the time any logger sees
 * it, and `redact.paths` only ever rewrites object properties.
 *
 * Losing the parameters costs little — the statement, its shape and its
 * duration are what a slow-query line is read for — and `DB_LOG_PARAMETERS`
 * brings them back for local debugging, where the data is not real.
 */
export class DbQueryLogger extends AbstractLogger {
  private readonly logger = new NestLogger('Database');

  public constructor(
    options: LoggerOptions,
    private readonly logParameters: boolean,
  ) {
    super(options);
  }

  /**
   * Renders one of TypeORM's log events and hands it to the application
   * logger.
   *
   * `prepareLogMessages` is the base class's own formatter and mutates the
   * messages it is given, which is why the result is read back from its
   * return value rather than from the argument.
   *
   * @param level - The level TypeORM chose for the event.
   * @param logMessage - One message, or the several one event can produce.
   * @param queryRunner - The runner the event came from, when there is one.
   */
  protected writeLog(
    level: LogLevel,
    logMessage: LogMessage | LogMessage[],
    queryRunner?: QueryRunner,
  ): void {
    const messages = this.prepareLogMessages(
      logMessage,
      {
        addColonToPrefix: true,
        appendParameterAsComment: this.logParameters,
        highlightSql: false,
        formatSql: false,
      },
      queryRunner,
    );

    messages.forEach((message) => {
      this.emit(level, message);
    });
  }

  /**
   * Writes one prepared message at the level its type implies.
   *
   * @param level - The level TypeORM chose for the whole event.
   * @param message - The prepared message to write.
   */
  private emit(level: LogLevel, message: LogMessage): void {
    const text = message.prefix
      ? `${message.prefix} ${String(message.message)}`
      : String(message.message);

    switch (message.type ?? level) {
      case 'query-error':
      case 'error':
        this.logger.error(text);
        break;
      case 'query-slow':
      case 'warn':
        this.logger.warn(text);
        break;
      case 'query':
        this.logger.debug(text);
        break;
      default:
        this.logger.log(text);
    }
  }
}
