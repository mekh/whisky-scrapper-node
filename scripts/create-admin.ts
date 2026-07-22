import 'dotenv/config';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

import { EntityManager } from 'typeorm';

import { UserEntity } from '~core/user';

import datasource from '../typeorm.config';

const ENTER_KEYS = ['\r', '\n'];
const BACKSPACE_KEYS = ['\b', '\u007f'];
const CTRL_C = '\u0003';

/**
 * Prompts for a single line of visible input.
 *
 * @param query - The message shown to the user before the input.
 * @returns The user's answer with surrounding whitespace removed.
 */
const promptText = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });

    rl.question(query, (answer) => {
      rl.close();

      resolve(answer.trim());
    });
  });
};

/**
 * Prompts for a masked line of input: every typed character is echoed as `*`,
 * and Backspace removes the last character until the user presses Enter. Falls
 * back to a plain hidden prompt when stdin is not an interactive TTY.
 *
 * @param query - The message shown to the user before the input.
 * @returns The exact characters the user entered (not trimmed).
 */
const promptMasked = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    const characters: string[] = [];

    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');

      resolve(characters.join(''));
    };

    const onData = (chunk: Buffer): void => {
      const input = chunk.toString('utf8');

      [...input].forEach((key) => {
        if (ENTER_KEYS.includes(key)) {
          finish();
        } else if (key === CTRL_C) {
          stdout.write('\n');
          process.exit(130);
        } else if (BACKSPACE_KEYS.includes(key)) {
          if (characters.length > 0) {
            characters.pop();
            stdout.write('\b \b');
          }
        } else {
          characters.push(key);
          stdout.write('*');
        }
      });
    };

    stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
};

/**
 * Prompts repeatedly until the user provides a non-empty value.
 *
 * @param label - Human-readable field name used in the prompt and message.
 * @param reader - Function that performs one prompt and returns the input.
 * @returns The first non-empty value the user entered.
 */
const requireValue = async (
  label: string,
  reader: (query: string) => Promise<string>,
): Promise<string> => {
  let value = '';

  while (value.length === 0) {
    value = await reader(`${label}: `);

    if (value.length === 0) {
      stdout.write(`${label} is required.\n`);
    }
  }

  return value;
};

/**
 * Interactively collects the required `UserEntity` fields (one at a time) and
 * persists a new active admin user through the given entity manager.
 *
 * @param manager - An initialized TypeORM entity manager used to save the user.
 * @returns Resolves once the admin user has been saved.
 */
export const createAdmin = async (manager: EntityManager): Promise<void> => {
  const name = await requireValue('name', promptText);
  const password = await requireValue('password', promptMasked);

  const user = manager.create(UserEntity, {
    name,
    password,
    active: true,
    admin: true,
  });

  await manager.save(user);

  stdout.write(`Admin user "${name}" created.\n`);
};

/**
 * Standalone entry point: opens a DB connection using `node/.env`, creates the
 * admin user, then closes the connection.
 *
 * @returns Resolves once the connection has been closed.
 */
const runStandalone = async (): Promise<void> => {
  const connection = await datasource.initialize();

  try {
    await createAdmin(connection.createEntityManager());
  } finally {
    await connection.destroy();
  }
};

if (require.main === module) {
  runStandalone()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);

      process.exit(1);
    });
}
