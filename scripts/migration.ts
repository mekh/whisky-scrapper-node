import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Thin wrapper around the TypeORM CLI that pins every migration command to the
 * `be/migrations` directory. It lets the package scripts accept a bare
 * migration name (e.g. `pnpm migration:generate init`) and expands it to the
 * full `migrations/<name>` path the CLI expects, so generated/created files
 * always land inside `migrations/` instead of the project root.
 */
const MIGRATIONS_DIR = 'migrations';
const DATA_SOURCE = './typeorm.config.ts';
const TS_NODE = 'ts-node';
const TYPEORM_CLI = './node_modules/typeorm/cli';

const USAGE = [
  'Usage:',
  '  pnpm migration:generate <name>   # diff entities -> new migration',
  '  pnpm migration:create <name>     # empty migration skeleton',
  '  pnpm migration:run               # apply pending migrations',
  '  pnpm migration:revert            # roll back the last migration',
].join('\n');

/**
 * Resolves a bare migration name to a path inside the migrations directory.
 *
 * @param name - The migration name passed on the command line, without any
 *   directory prefix. Required for the `generate` and `create` commands.
 * @returns The `migrations/<name>` path handed to the TypeORM CLI.
 * @throws {Error} If `name` is missing or empty.
 */
function resolveMigrationPath(name: string | undefined): string {
  if (!name) {
    throw new Error(`A migration name is required.\n\n${USAGE}`);
  }

  return path.join(MIGRATIONS_DIR, name);
}

/**
 * Builds the TypeORM CLI argument list for a given migration command.
 *
 * @param command - The sub-command: `generate`, `create`, `run` or `revert`.
 * @param rest - Remaining CLI arguments; `rest[0]` is the migration name for
 *   `generate`/`create`, and anything after it is forwarded to the CLI as-is.
 * @returns The argument vector to pass to the TypeORM CLI.
 * @throws {Error} If `command` is unknown or a required name is missing.
 */
function buildCliArgs(
  command: string | undefined,
  rest: string[],
): string[] {
  switch (command) {
    case 'generate': {
      const path = resolveMigrationPath(rest[0]);

      return [
        'migration:generate',
        path,
        '-d',
        DATA_SOURCE,
        '-p',
        ...rest.slice(1),
      ];
    }
    case 'create': {
      const path = resolveMigrationPath(rest[0]);

      return ['migration:create', path, ...rest.slice(1)];
    }
    case 'run': {
      return ['migration:run', '-d', DATA_SOURCE, ...rest];
    }
    case 'revert': {
      return ['migration:revert', '-d', DATA_SOURCE, ...rest];
    }
    default: {
      throw new Error(`Unknown command: ${command ?? '(none)'}\n\n${USAGE}`);
    }
  }
}

/**
 * Parses process arguments, runs the TypeORM CLI under ts-node, and exits with
 * the child process status.
 *
 * @returns Nothing; terminates the process via `process.exit`.
 * @throws {Error} If argument parsing fails or the child cannot be spawned.
 */
const main = (): void => {
  const [command, ...rest] = process.argv.slice(2);

  const cliArgs = buildCliArgs(command, rest);

  const result = spawnSync(
    TS_NODE,
    ['-r', 'tsconfig-paths/register', TYPEORM_CLI, ...cliArgs],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
};

main();
