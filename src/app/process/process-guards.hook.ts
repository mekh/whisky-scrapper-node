import { Logger } from '@nestjs/common';

const logger = new Logger('ProcessGuards');

/**
 * Writes what reached the process, in two calls rather than one.
 *
 * The error is logged on its own — the idiom the global exception filter
 * already uses — and deliberately not interpolated into the first line with
 * `%o`. Passed alone it arrives as pino's `err`, which is the root the
 * redaction paths are written against: `err.parameters` keeps a
 * `QueryFailedError`'s bound values out of the log and `err.driverError.
 * detail` keeps PostgreSQL's echo of the offending row out. Interpolating it
 * would reroot those paths to the error itself and silently uncover both.
 *
 * @param kind - Which hook caught it.
 * @param error - The thrown value or rejection reason.
 */
const report = (kind: string, error: unknown): void => {
  logger.error('%s — the process is staying up, this is a defect', kind);
  logger.error(error);
};

/**
 * Stops an error nobody is waiting for from taking the whole API down.
 *
 * Installed because it already has: under load on 2026-09-13 the process
 * died twice in four minutes with nothing in the log but Node's own fatal
 * dump, and the cause was a `pg-pool` connection-acquire timeout. That error
 * is raised from a `setTimeout` callback (`pg-pool/index.js:224`) and
 * delivered by rejecting the promise `pool.connect()` returned; when the
 * request that asked for the connection has already gone — its own deadline
 * passed, its socket closed — the rejection reaches no `await` and Node
 * terminates the process by default. `pg-pool` also calls
 * `Error.captureStackTrace` on the way out, which is why the trace named
 * only `Timeout._onTimeout` and no application frame.
 *
 * The cost of dying there is measured, not hypothetical: every in-flight
 * request is dropped, and the restart bumps the catalogue generation twice
 * (boot, then the knowledge-base apply pass), so the cache is cold for
 * everyone at the exact moment the service is already struggling. A request
 * that legitimately failed has been answered by its own error path long
 * before this; the orphaned copy carries no information the log does not
 * already have.
 *
 * `uncaughtException` is treated the same way by the owner's decision. The
 * caveat that comes with it is the standard one and is worth keeping in
 * mind: a synchronous throw that escaped every handler can leave state the
 * process was midway through changing, so a line from this hook is a defect
 * to go and fix, never an outcome to accept.
 */
export const registerProcessGuards = (): void => {
  process.on('unhandledRejection', (reason: unknown) => {
    report('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error: unknown) => {
    report('Uncaught exception', error);
  });
};
