import 'dotenv/config';
import { join } from 'node:path';

import { DataSource } from 'typeorm';

import { DbConfig } from './src/config';

const config = new DbConfig();

/**
 * Entity/migration globs are anchored to `__dirname`, not the process CWD,
 * so this one file works in both layouts: via ts-node from the repo root in
 * dev (matches the `.ts` sources) and as compiled `dist/typeorm.config.js`
 * inside the production image (`__dirname` = `/app/dist`, matches the `.js`
 * output). TypeORM's directory loader skips `.d.ts` files on its own, so the
 * dual-extension glob is safe.
 */
export default new DataSource({
  ...config,
  entities: [join(__dirname, 'src/core/**/*.entity{.ts,.js}')],
  migrations: [join(__dirname, 'migrations/*{.ts,.js}')],
});
