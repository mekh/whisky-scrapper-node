import { ValkeyClient } from '@toxicoder/nestjs-valkey';
import type { ValkeyCluster } from '@toxicoder/nestjs-valkey/dist/valkey.interfaces';

/**
 * What a client looks like once a script has been defined on it: the command
 * is added to the object under a name no type can know in advance.
 */
type ScriptedClient = Record<
  string,
  (...args: (string | number)[]) => Promise<unknown>
>;

/**
 * One Lua script, registered on the client and callable as a command.
 *
 * The registration is what makes this worth a class: the driver sends
 * `EVALSHA` and falls back to `EVAL` per connection on `NOSCRIPT`, so a
 * Valkey restart or a `SCRIPT FLUSH` re-loads the script instead of failing
 * the caller.
 */
export class ValkeyScript {
  private readonly client: ScriptedClient;

  /**
   * Registers the script on the client under a command name.
   *
   * @param client - The connection to register on.
   * @param name - Command name to register it as, unique per client.
   * @param lua - The script's source.
   */
  public constructor(
    client: ValkeyClient | ValkeyCluster,
    private readonly name: string,
    lua: string,
  ) {
    client.defineCommand(name, { lua });

    this.client = client as unknown as ScriptedClient;
  }

  /**
   * Runs the script, atomically as every Valkey script is.
   *
   * @param keys - The keys the script may touch, as `KEYS`.
   * @param args - Everything else the script reads, as `ARGV`.
   * @returns Whatever the script returned, in the driver's own encoding.
   * @throws {Error} When the command fails or the connection does.
   */
  public async run(
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    const command = this.client[this.name];

    if (!command) {
      throw new Error(`Valkey script ${this.name} is not registered`);
    }

    return command.call(this.client, keys.length, ...keys, ...args);
  }
}
