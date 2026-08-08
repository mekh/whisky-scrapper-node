import 'dotenv/config';
import { stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { DbConfig } from '../src/config';
import datasource from '../typeorm.config';

const dbConfig = new DbConfig();

const RETRY_ATTEMPTS = dbConfig.retryAttempts ?? 10;

const RETRY_DELAY_MS = dbConfig.retryDelay ?? 3000;

/**
 * Waits for the database to accept connections. Right after `docker compose
 * up` the DB container may still be starting, so the initial connection is
 * retried; nothing else is.
 *
 * @returns Resolves once the connection is established.
 * @throws The last connection error once every attempt is spent.
 */
const connectWithRetry = async (): Promise<void> => {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      await datasource.initialize();

      return;
    } catch (error) {
      if (attempt === RETRY_ATTEMPTS) {
        throw error;
      }

      stdout.write(
        `DB is not ready (attempt ${attempt.toString()}/`
          + `${RETRY_ATTEMPTS.toString()}); retrying in `
          + `${RETRY_DELAY_MS.toString()}ms...\n`,
      );

      await sleep(RETRY_DELAY_MS);
    }
  }
};

/**
 * Non-interactive production migration runner: connects (with retries),
 * applies every pending migration, prints what ran, and closes the
 * connection. Runs as the `migrate` compose service; its exit code gates the
 * app container via `depends_on: condition: service_completed_successfully`.
 *
 * @returns Resolves once migrations have run and the connection is closed.
 * @throws Any connection or migration failure (non-zero process exit).
 */
const migrate = async (): Promise<void> => {
  await connectWithRetry();

  try {
    stdout.write('Running migrations...\n');

    const migrations = await datasource.runMigrations();

    migrations.forEach((migration) => {
      stdout.write(`Applied: ${migration.name}\n`);
    });

    stdout.write(`Applied ${migrations.length.toString()} migration(s).\n`);
  } finally {
    await datasource.destroy();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
