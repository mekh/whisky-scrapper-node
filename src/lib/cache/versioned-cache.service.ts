import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { CacheConfig } from '~config';
import {
  CACHE_GENERATION_CATALOGUE,
  CACHE_KEY_ROOT,
  CACHE_SLOW_COMMAND_MS,
} from '~constants';
import {
  ValkeyService,
  type ValkeyClient,
  type ValkeyCluster,
} from '~lib/valkey';
import type { CacheEntryRef, CacheStats } from '~types';
import { ErrorUtils, TransactionUtils } from '~utils';

import { CacheCodec } from './cache-codec.util';

/**
 * What one command may be handed to work with.
 */
type CacheClient = ValkeyClient | ValkeyCluster;

/**
 * The shape `MULTI ... EXEC` answers with: one `[error, result]` pair per
 * queued command, or null when the transaction was discarded.
 */
type TransactionReplies = [Error | null, unknown][] | null;

/**
 * A version-keyed cache: entries are never deleted, they are addressed by a
 * generation counter that changes whenever the data behind them does.
 *
 * **Why a generation rather than deleting keys on write.** A report request
 * that overlaps a write reads pre-commit rows, and if invalidation is a
 * delete then the write's delete lands *before* that request stores its
 * result — so the stale answer is written after the flush and served until
 * something else happens to write, which for this catalogue can be a day
 * later. It is a well-documented failure (the "stale set" of Facebook's
 * memcache paper) and it is not a rare interleaving here: a store's persist
 * transaction can run for minutes. Reading the generation *before* the query
 * closes it — the slow request stores its answer under the generation it
 * read, and once the writer has bumped, nothing addresses that key again.
 *
 * **Everything degrades to a miss.** A cache is an optimisation; a request
 * must never fail because of one. Every command is bounded by its own
 * deadline, well under the client's, and every failure returns null so the
 * caller runs its loader. The one thing that is *not* treated as harmless is
 * a failed bump: that means a write happened which the cache was not told
 * about, so until a bump succeeds the cache is bypassed altogether. Serving
 * a stale catalogue is worse than serving a slow one.
 */
@Injectable()
export class VersionedCacheService
  implements OnApplicationBootstrap, OnModuleDestroy {
  /**
   * Seeds a generation that does not exist yet.
   *
   * Epoch seconds rather than zero, so that a generation which was deleted —
   * a flushed instance, a key removed by hand — restarts *above* every value
   * an entry still in memory was stored under. Starting from zero would let
   * a surviving old entry be addressed again.
   *
   * @returns The value to seed a missing generation with.
   */
  private static seed(): number {
    return Math.floor(Date.now() / 1000);
  }

  private readonly logger = new Logger(VersionedCacheService.name);

  private readonly counters = {
    hits: 0,
    misses: 0,
    errors: 0,
    bypasses: 0,
  };

  private generation: number | null = null;

  private lastBumpAt: number | null = null;

  private pending: { generation: string; reason: string } | null = null;

  public constructor(
    private readonly config: CacheConfig,
    private readonly valkey: ValkeyService,
  ) {}

  /**
   * Bumps the catalogue generation once the application is up.
   *
   * This is what makes a deploy safe. Migrations run before the process
   * starts and `KbBootApplyService` rewrites facts during startup; both are
   * catalogue writes that no in-process hook can see, and a script run while
   * the app was down is a third. One bump at boot supersedes everything they
   * touched, whatever it was.
   *
   * A process that serves no reads skips it (`CACHE_BOOT_BUMP`): the
   * standalone scripts carry this module only to invalidate the API's cache
   * when they *finish*, and bumping as they start would discard entries the
   * script is about to supersede anyway — on a dry run, which is meant to
   * change nothing, most obviously of all.
   *
   * @returns Resolves once the generation has been bumped.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('Catalogue cache is disabled (CACHE_ENABLED)');

      return;
    }

    if (!this.config.bootBump) {
      return;
    }

    await this.bump(CACHE_GENERATION_CATALOGUE, 'boot');
  }

  /**
   * Closes the connection so a process that only borrowed the cache can
   * exit.
   *
   * Not optional housekeeping: the standalone scripts boot a Nest context
   * carrying this module, and an open client keeps the event loop alive
   * forever.
   */
  public onModuleDestroy(): void {
    try {
      this.valkey.disconnect();
    } catch (error) {
      this.logger.warn(
        'Cache client did not close cleanly: %s',
        ErrorUtils.text(error),
      );
    }
  }

  /**
   * Answers from the cache, or computes the value and stores it.
   *
   * @param ref - What is being cached.
   * @param generation - Which generation counter governs it.
   * @param loader - Computes the value on a miss.
   * @returns The cached or freshly computed value.
   */
  public async getOrCompute<T>(
    ref: CacheEntryRef,
    generation: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const version = await this.usableGeneration(generation);

    if (version === null) {
      this.counters.bypasses += 1;

      return loader();
    }

    const key = this.entryKey(ref, version);
    const cached = await this.read<T>(key);

    if (cached) {
      this.counters.hits += 1;

      return cached.value;
    }

    const value = await loader();

    this.counters.misses += 1;
    await this.write(key, value);

    return value;
  }

  /**
   * Moves a generation on, so every entry stored under the old one becomes
   * unreachable.
   *
   * Never rejects: a caller is a write path that has already succeeded, and
   * the write must not be undone by the cache having a bad moment. A failure
   * is recorded instead, and bypasses every read until a later bump clears
   * it.
   *
   * @param generation - Which counter to move.
   * @param reason - What moved it, for the log line.
   * @returns Resolves once the bump has been attempted.
   */
  public async bump(generation: string, reason: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const key = this.generationKey(generation);

    const replies = await this.command(
      'generation bump',
      (client) =>
        client.multi()
          .set(key, String(VersionedCacheService.seed()), 'NX')
          .incr(key)
          .exec() as Promise<TransactionReplies>,
    );

    if (!replies) {
      this.pending = { generation, reason };

      this.logger.warn(
        'Catalogue cache generation could not be bumped after %s;'
          + ' bypassing the cache until it can be',
        reason,
      );

      return;
    }

    this.pending = null;
    this.lastBumpAt = Date.now();
    this.generation = Number(replies[1]?.[1] ?? this.generation);

    this.logger.log(
      'Catalogue cache generation -> %s (%s)',
      String(this.generation),
      reason,
    );
  }

  /**
   * Registers a bump to run once the surrounding transaction commits, or
   * immediately when there is none.
   *
   * The ordering is the whole point: a bump that ran before the commit would
   * be superseded by every request that read the pre-commit rows.
   *
   * @param generation - Which counter to move.
   * @param reason - What moved it, for the log line.
   */
  public bumpAfterCommit(generation: string, reason: string): void {
    TransactionUtils.afterCommit(() => {
      void this.bump(generation, reason);
    });
  }

  /**
   * Reads a generation, seeding it when the counter does not exist yet.
   *
   * @param generation - Which counter to read.
   * @returns Its current value, or null when the cache could not answer.
   */
  public async readGeneration(generation: string): Promise<number | null> {
    const key = this.generationKey(generation);

    const current = await this.command(
      'generation read',
      (client) => client.get(key),
    );

    if (current !== null) {
      return this.remember(current);
    }

    await this.command(
      'generation seed',
      (client) => client.set(key, String(VersionedCacheService.seed()), 'NX'),
    );

    const seeded = await this.command(
      'generation read',
      (client) => client.get(key),
    );

    return seeded === null ? null : this.remember(seeded);
  }

  /**
   * What the cache has done since the process started.
   *
   * @returns The running counters and the current generation.
   */
  public stats(): CacheStats {
    return {
      enabled: this.config.enabled,
      ...this.counters,
      generation: this.generation,
      lastBumpAt: this.lastBumpAt,
      dirty: this.pending !== null,
    };
  }

  /**
   * Round-trips a `PING` to the cache's own instance.
   *
   * It is proxied rather than the client being handed out because the
   * client is not reachable from outside this module by design — and the
   * watchdog does have to reach it: when the cache has an instance of its
   * own, that instance is a second thing that can stall, and the session
   * ping says nothing about it.
   *
   * @returns The server's reply.
   */
  public async ping(): Promise<string> {
    return this.valkey.ping();
  }

  /**
   * Resolves the generation to address entries under, or null when the cache
   * must not be used for this read.
   *
   * @param generation - Which counter governs the entry.
   * @returns The generation, or null to bypass the cache.
   */
  private async usableGeneration(generation: string): Promise<number | null> {
    if (!this.config.enabled) {
      return null;
    }

    const outstanding = this.pending;

    if (outstanding) {
      await this.bump(outstanding.generation, outstanding.reason);

      if (this.pending) {
        return null;
      }
    }

    return this.readGeneration(generation);
  }

  /**
   * Reads one entry.
   *
   * The result is wrapped so that a stored `null` is not read as a miss —
   * cheap here, and the alternative is a cache that silently never serves a
   * legitimately empty answer.
   *
   * @param key - The entry's full key.
   * @returns The value in a wrapper, or null when there is nothing usable.
   */
  private async read<T>(key: string): Promise<{ value: T } | null> {
    const payload = await this.command(
      'entry read',
      (client) => client.getBuffer(key),
    );

    if (payload === null) {
      return null;
    }

    try {
      return { value: await CacheCodec.decode<T>(payload) };
    } catch (error) {
      this.counters.errors += 1;

      this.logger.warn(
        'Cache entry %s could not be decoded, dropping it: %s',
        key,
        ErrorUtils.text(error),
      );

      await this.command('entry drop', (client) => client.del(key));

      return null;
    }
  }

  /**
   * Stores one entry, unless it is too large to be worth keeping.
   *
   * @param key - The entry's full key.
   * @param value - The value to store.
   * @returns Resolves once the write has been attempted.
   */
  private async write(key: string, value: unknown): Promise<void> {
    const payload = await CacheCodec.encode(value);

    if (payload.byteLength > this.config.maxEntryBytes) {
      this.counters.bypasses += 1;

      this.logger.warn(
        'Cache entry %s is %d bytes, past the %d-byte cap; not storing it',
        key,
        payload.byteLength,
        this.config.maxEntryBytes,
      );

      return;
    }

    await this.command(
      'entry write',
      (client) => client.set(key, payload, 'EX', this.config.ttlSec),
    );
  }

  /**
   * Runs one cache command, bounded and logged on both sides.
   *
   * The line *before* the command is the point of the wrapper, and it is
   * there for a reason this application has already paid for: a command that
   * never returns leaves no completion line and no error, so the only
   * evidence it was ever sent has to be written first.
   *
   * Failures are logged as text rather than as the error object. A client
   * error carries the command it failed on, arguments and all — which for a
   * write is the entire compressed payload.
   *
   * @param operation - What to call this command in the log.
   * @param run - Issues the command against the client.
   * @returns The reply, or null when it failed, timed out or found nothing.
   */
  private async command<T>(
    operation: string,
    run: (client: CacheClient) => Promise<T>,
  ): Promise<T | null> {
    const startedAt = Date.now();

    this.logger.verbose('Cache %s: sending', operation);

    try {
      const result = await this.bounded(run(this.valkey.getClient()));
      const elapsed = Date.now() - startedAt;

      if (elapsed >= CACHE_SLOW_COMMAND_MS) {
        this.logger.warn('Cache %s: slow, %d ms', operation, elapsed);
      } else {
        this.logger.verbose('Cache %s: done in %d ms', operation, elapsed);
      }

      return result;
    } catch (error) {
      this.counters.errors += 1;

      this.logger.warn(
        'Cache %s failed after %d ms, using the database: %s',
        operation,
        Date.now() - startedAt,
        ErrorUtils.text(error),
      );

      return null;
    }
  }

  /**
   * Races a command against its own deadline.
   *
   * Not redundant with the client's `commandTimeout`: this one is far
   * shorter, because a cache that answers slower than the query it replaces
   * has nothing to offer the request, and because it still bounds the wait
   * if the client's own timeout is ever misconfigured.
   *
   * @param command - The command already in flight.
   * @returns Its reply.
   * @throws {Error} When the deadline passes first.
   */
  private async bounded<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${this.config.readTimeoutMs} ms`));
      }, this.config.readTimeoutMs);

      timer.unref();
    });

    try {
      return await Promise.race([command, deadline]);
    } finally {
      clearTimeout(timer);

      /**
       * When the deadline won, the command is still in flight and may still
       * reject; without a handler that would surface as an unhandled
       * rejection and, depending on the runtime's settings, end the process.
       */
      command.catch(() => undefined);
    }
  }

  /**
   * Records a generation read from the cache.
   *
   * @param raw - The counter's value as the cache stated it.
   * @returns The parsed generation, or null when it was not a number.
   */
  private remember(raw: string): number | null {
    const value = Number(raw);

    if (!Number.isFinite(value)) {
      this.logger.warn('Cache generation is not a number: %s', raw);

      return null;
    }

    this.generation = value;

    return value;
  }

  /**
   * The key a generation counter lives under.
   *
   * @param generation - The counter's name.
   * @returns Its key.
   */
  private generationKey(generation: string): string {
    return `${CACHE_KEY_ROOT}:gen:${generation}`;
  }

  /**
   * The key one entry lives under, for one generation.
   *
   * @param ref - What is being cached.
   * @param version - The generation it belongs to.
   * @returns The entry's key.
   */
  private entryKey(ref: CacheEntryRef, version: number): string {
    const base = `${CACHE_KEY_ROOT}:${ref.scope}:g${version}`;

    return ref.suffix ? `${base}:${ref.suffix}` : base;
  }
}
