import type { Config } from 'jest';

/**
 * Integration tests run only the `*.integration.spec.ts` files and require a
 * live Postgres (`docker compose -f docker-compose.dev.yaml up -d`). They are
 * excluded from the default `pnpm test` run. Config mirrors `jest.config.ts`
 * (kept inline rather than imported — Jest's nodenext config loader will not
 * resolve an extensionless relative import).
 */
const config: Config = {
  verbose: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: '.integration.spec.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30_000,
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  moduleNameMapper: {
    '^~types$': '<rootDir>/src/interfaces',
    '^~types/(.*)$': '<rootDir>/src/interfaces/$1',
    '^~core/common$': '<rootDir>/src/core/_common',
    '^~core/common/(.*)$': '<rootDir>/src/core/_common/$1',
    '^~domain/common$': '<rootDir>/src/domain/_common',
    '^~domain/common/(.*)$': '<rootDir>/src/domain/_common/$1',
    '^~(.*)$': '<rootDir>/src/$1',
  },
};

export default config;
