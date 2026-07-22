import type { Config } from 'jest';

const config: Config = {
  verbose: true,
  maxWorkers: 1,
  forceExit: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './',
  testEnvironment: 'node',
  testRegex: '.e2e.spec.ts$',
  collectCoverageFrom: ['src/**/*.{js,ts}'],
  coveragePathIgnorePatterns: ['src/main.ts'],
  detectOpenHandles: true,
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  moduleNameMapper: {
    '~common/(.*)': '<rootDir>/src/core/_common/$1',
    '~(.*)': '<rootDir>/src/$1',
  },
  setupFiles: [
    'dotenv/config',
  ],
};

export default config;
