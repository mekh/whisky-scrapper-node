import 'dotenv/config';
import { stdout } from 'node:process';

import datasource from '../typeorm.config';
import { createAdmin } from './create-admin';

/**
 * One-time application bootstrap: opens a DB connection using `be/.env`,
 * applies every pending migration, then interactively creates the first admin
 * user. Meant to be run once, right after the app is provisioned.
 *
 * @returns Resolves once migrations have run, the admin exists, and the
 *   connection has been closed.
 */
const init = async (): Promise<void> => {
  const connection = await datasource.initialize();

  try {
    stdout.write('Running migrations...\n');

    const migrations = await connection.runMigrations();

    stdout.write(`Applied ${migrations.length.toString()} migration(s).\n`);

    await createAdmin(connection.createEntityManager());
  } finally {
    await connection.destroy();
  }
};

init()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
