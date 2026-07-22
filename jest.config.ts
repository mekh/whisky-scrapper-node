import type { Config } from 'jest';

const config: Config = {
  verbose: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: './',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: '.spec.ts$',
  testPathIgnorePatterns: ['/node_modules/', '.e2e.spec.ts$'],
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
