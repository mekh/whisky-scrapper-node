import 'dotenv/config';
import { DataSource } from 'typeorm';

import { DbConfig } from './src/config';

const config = new DbConfig();

export default new DataSource({
  ...config,
  entities: ['src/core/**/*.entity.ts'],
  migrations: ['migrations/*.*'],
});
