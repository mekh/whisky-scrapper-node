import 'dotenv/config';
import 'reflect-metadata';

import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions, Like } from 'typeorm';
import {
  addTransactionalDataSource,
  getDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { ConfigModule, DbConfig } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CorePreferenceService } from '~core/preference';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { CoreQuickFilterService } from '~core/quick-filter';
import { CoreUserService } from '~core/user';
import {
  CoreUserCollectionPurchaseService,
  CoreUserCollectionService,
} from '~core/user-collection';
import { AuthService, DomainAuthModule } from '~domain/auth';
import { KbStatus } from '~enums';
import { ID, QuickFilterCreateInput } from '~types';

import {
  LoadtestCatalogueSample,
  LoadtestPrefsTally,
  LoadtestSeedOptions,
  LoadtestUserRecord,
  LoadtestUsersFile,
} from './loadtest-seed.interfaces';

const DEFAULT_USERS = 1000;

const MAX_USERS = 10000;

const DEFAULT_PREFIX = 'loadtest-';

/**
 * A shorter prefix would let `--cleanup` match real accounts by accident.
 */
const MIN_PREFIX_LENGTH = 5;

const DEFAULT_OUT = 'loadtest/users.json';

/**
 * Users created (and Argon2 hashes computed) at once.
 */
const CONCURRENCY = 8;

const PROGRESS_EVERY = 100;

const USER_AGENT = 'k6-loadtest';

/**
 * Random bytes behind the shared password; base64url makes 24 characters.
 */
const PASSWORD_BYTES = 18;

const PRODUCT_SAMPLE = 3000;

const PRODUCER_SAMPLE = 300;

const FAVORITES_SHARE = 0.3;

const BLACKLIST_SHARE = 0.15;

const QUICK_FILTER_SHARE = 0.2;

const COLLECTION_SHARE = 0.1;

const MS_PER_DAY = 86_400_000;

/**
 * Saved filter sets a user may hold, spelled with the report's own parameter
 * names so a k6 persona can replay one verbatim.
 */
const QUICK_FILTER_TEMPLATES: QuickFilterCreateInput[] = [
  { name: 'Scotch', filters: { countries: ['GB-SCT'] } },
  { name: 'No peat', filters: { excludeFlavors: ['peated'] } },
  { name: 'Under 2000', filters: { maxPrice: 2000 } },
  { name: 'Single malt', filters: { types: ['single malt'] } },
  { name: 'Islay', filters: { regions: ['islay'] } },
  { name: 'Sherry bombs', filters: { flavors: ['sherry'], minPrice: 1500 } },
];

/**
 * Standalone module: TypeORM (transactional data source), the whole core
 * graph for entity registration, and the auth domain for real sessions.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [
        ConfigModule,
      ],
      inject: [
        DbConfig,
      ],
      useFactory: (config: DbConfig): DataSourceOptions =>
        ({ ...config }) as DataSourceOptions,
      dataSourceFactory: async (
        options?: DataSourceOptions,
      ): Promise<DataSource> => {
        if (!options) {
          throw new Error('Missing TypeORM data source options');
        }

        return getDataSourceByName('default')
          ?? addTransactionalDataSource(new DataSource(options));
      },
    }),
    ConfigModule,
    CoreWhiskyModule,
    DomainAuthModule,
  ],
})
class LoadtestSeedModule {}

/**
 * Deterministic generator (mulberry32), so a re-seed gives every user the
 * same preferences and two environments can be compared.
 */
class SeededRandom {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * Draws the next number in `[0, 1)`.
   *
   * @returns A pseudo-random float.
   */
  public next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;

    let t = this.state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Draws an integer in `[min, max]`.
   *
   * @param min - Lowest value, inclusive.
   * @param max - Highest value, inclusive.
   * @returns The drawn integer.
   */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Draws `count` distinct items, fewer when the list is shorter than that.
   *
   * @param items - The pool to draw from.
   * @param count - How many distinct items to draw.
   * @returns The drawn items, in draw order.
   */
  public pick<T>(items: T[], count: number): T[] {
    const wanted = Math.min(count, items.length);
    const chosen = new Set<number>();

    while (chosen.size < wanted) {
      chosen.add(this.int(0, items.length - 1));
    }

    return [...chosen].map((index) => items[index] as T);
  }
}

/**
 * Creates the load-test population — users, sessions and, on request, the
 * preferences that make personalised reads do real work — or removes it.
 */
class LoadtestSeeder {
  /**
   * Derives the address a user presents, one per index inside `10.0.0.0/8`.
   *
   * @param index - The user's one-based index.
   * @returns A dotted IPv4 address.
   */
  private static spoofedIp(index: number): string {
    return `10.${(index >>> 16) & 255}.${(index >>> 8) & 255}.${index & 255}`;
  }

  /**
   * Reads the `exp` claim off a JWT without verifying it.
   *
   * @param token - The compact JWT.
   * @returns The expiry in epoch seconds, or 0 when the claim is absent.
   */
  private static decodeExp(token: string): number {
    const [, payload = ''] = token.split('.');
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as { exp?: number };

    return claims.exp ?? 0;
  }

  /**
   * Splits a list into consecutive slices.
   *
   * @param items - The list to split.
   * @param size - Slice length.
   * @returns The slices, in order.
   */
  private static chunk<T>(items: T[], size: number): T[][] {
    return Array.from(
      { length: Math.ceil(items.length / size) },
      (_, i) => items.slice(i * size, (i + 1) * size),
    );
  }

  /**
   * Formats a day as `YYYY-MM-DD`, UTC.
   *
   * @param daysAgo - How many days before now.
   * @returns The calendar day.
   */
  private static isoDay(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * MS_PER_DAY).toISOString()
      .slice(0, 10);
  }

  /**
   * A tally with every counter at zero.
   *
   * @returns The empty tally.
   */
  private static emptyTally(): LoadtestPrefsTally {
    return {
      favorites: 0,
      blacklistProducts: 0,
      blacklistProducers: 0,
      quickFilters: 0,
      collectionRows: 0,
      purchases: 0,
    };
  }

  /**
   * Adds two tallies.
   *
   * @param left - One tally.
   * @param right - The other.
   * @returns Their sum.
   */
  private static addTally(
    left: LoadtestPrefsTally,
    right: LoadtestPrefsTally,
  ): LoadtestPrefsTally {
    return {
      favorites: left.favorites + right.favorites,
      blacklistProducts: left.blacklistProducts + right.blacklistProducts,
      blacklistProducers: left.blacklistProducers + right.blacklistProducers,
      quickFilters: left.quickFilters + right.quickFilters,
      collectionRows: left.collectionRows + right.collectionRows,
      purchases: left.purchases + right.purchases,
    };
  }

  private readonly users: CoreUserService;

  private readonly auth: AuthService;

  private readonly preferences: CorePreferenceService;

  private readonly quickFilters: CoreQuickFilterService;

  private readonly collection: CoreUserCollectionService;

  private readonly purchases: CoreUserCollectionPurchaseService;

  private readonly products: CoreProductService;

  private readonly producers: CoreProducerService;

  public constructor(
    app: INestApplicationContext,
    private readonly options: LoadtestSeedOptions,
  ) {
    this.users = app.get(CoreUserService);
    this.auth = app.get(AuthService);
    this.preferences = app.get(CorePreferenceService);
    this.quickFilters = app.get(CoreQuickFilterService);
    this.collection = app.get(CoreUserCollectionService);
    this.purchases = app.get(CoreUserCollectionPurchaseService);
    this.products = app.get(CoreProductService);
    this.producers = app.get(CoreProducerService);
  }

  /**
   * Creates the users with one live session each, optionally their
   * preferences, and writes the token file.
   *
   * @throws {Error} When users with the prefix already exist, so a second
   *   run cannot create a second account under a name login resolves by.
   */
  public async seed(): Promise<void> {
    await this.assertNoLeftovers();

    const password = crypto.randomBytes(PASSWORD_BYTES).toString('base64url');

    console.log(
      `Creating ${this.options.users} user(s) with prefix `
        + `"${this.options.prefix}"...`,
    );

    const records = await this.createUsers(password);

    const prefs = this.options.prefs
      ? await this.seedPreferences(records)
      : null;

    const file: LoadtestUsersFile = {
      createdAt: new Date().toISOString(),
      prefix: this.options.prefix,
      password,
      accessTtlSec: this.options.accessTtl ?? null,
      users: records,
    };

    await this.writeOutput(file);

    this.report(records, prefs);
  }

  /**
   * Revokes every session of the seeded users and deletes them; favourites,
   * blacklist entries, quick filters and collection rows cascade.
   */
  public async cleanup(): Promise<void> {
    const rows = await this.findSeeded();

    if (!rows.length) {
      console.log(`No user carries the prefix "${this.options.prefix}".`);

      return;
    }

    console.log(`Revoking the sessions of ${rows.length} user(s)...`);

    await this.forEachChunk(rows, (row) => this.auth.revokeAllSessions(row.id));

    const result = await this.users.deleteByIds(rows.map((row) => row.id));

    console.log(
      `Deleted ${result.affected ?? 0} user(s); their preferences, quick `
        + 'filters and collection rows cascaded.',
    );
  }

  /**
   * Loads every user carrying the seed prefix.
   *
   * @returns The matching users.
   */
  private findSeeded(): Promise<{ id: ID }[]> {
    return this.users.findMany(
      { name: Like(`${this.options.prefix}%`) },
      { select: { id: true } },
    );
  }

  /**
   * Refuses to seed on top of an earlier population.
   *
   * @throws {Error} When any user with the prefix exists.
   */
  private async assertNoLeftovers(): Promise<void> {
    const existing = await this.findSeeded();

    if (existing.length) {
      throw new Error(
        `${existing.length} user(s) with prefix "${this.options.prefix}" `
          + 'already exist — run with --cleanup first',
      );
    }
  }

  /**
   * Creates the users and opens one session per user, a chunk at a time.
   *
   * @param password - The shared plaintext password.
   * @returns The records, ordered by index.
   */
  private createUsers(password: string): Promise<LoadtestUserRecord[]> {
    const indexes = Array.from(
      { length: this.options.users },
      (_, i) => i + 1,
    );

    return this.forEachChunk(
      indexes,
      (index) => this.createUser(index, password),
      (done) => this.progress('users', done, indexes.length),
    );
  }

  /**
   * Creates one unprivileged user and a session recorded under its own
   * address.
   *
   * @param index - The user's one-based index.
   * @param password - The shared plaintext password.
   * @returns The record k6 will read.
   */
  private async createUser(
    index: number,
    password: string,
  ): Promise<LoadtestUserRecord> {
    const width = Math.max(4, String(this.options.users).length);
    const name = `${this.options.prefix}${String(index).padStart(width, '0')}`;
    const ip = LoadtestSeeder.spoofedIp(index);

    const user = await this.users.createOne({
      name,
      password,
      active: true,
      admin: false,
    });

    const tokens = await this.auth.createSession({
      user: { id: user.id, admin: false, permissions: [] },
      ip,
      userAgent: USER_AGENT,
    });

    return {
      index,
      id: user.id,
      name,
      ip,
      access: tokens.access,
      refresh: tokens.refresh,
      accessExp: LoadtestSeeder.decodeExp(tokens.access),
    };
  }

  /**
   * Gives a share of the users favourites, blacklist entries, quick filters
   * and collection rows drawn from the live catalogue.
   *
   * @param records - The seeded users.
   * @returns How many rows were written.
   */
  private async seedPreferences(
    records: LoadtestUserRecord[],
  ): Promise<LoadtestPrefsTally> {
    const sample = await this.loadCatalogueSample();

    console.log(
      `Seeding preferences from ${sample.productIds.length} bottling(s) and `
        + `${sample.producerIds.length} producer(s)...`,
    );

    const tallies = await this.forEachChunk(
      records,
      (record) => this.seedUserPreferences(record, sample),
      (done) => this.progress('preferences', done, records.length),
    );

    return tallies.reduce(
      (sum, item) => LoadtestSeeder.addTally(sum, item),
      LoadtestSeeder.emptyTally(),
    );
  }

  /**
   * Writes one user's preferences, decided by a generator seeded with the
   * user's index.
   *
   * @param record - The user.
   * @param sample - The catalogue rows to draw from.
   * @returns How many rows this user got.
   */
  private async seedUserPreferences(
    record: LoadtestUserRecord,
    sample: LoadtestCatalogueSample,
  ): Promise<LoadtestPrefsTally> {
    const rng = new SeededRandom(record.index);

    const favorites = rng.next() < FAVORITES_SHARE
      ? rng.pick(sample.productIds, rng.int(3, 8))
      : [];

    if (favorites.length) {
      await this.preferences.addFavorites(record.id, favorites);
    }

    const favoriteSet = new Set(favorites);

    const hidden = rng.next() < BLACKLIST_SHARE
      ? rng.pick(
        sample.productIds.filter((id) => !favoriteSet.has(id)),
        rng.int(1, 3),
      )
      : [];

    const hiddenProducers = hidden.length
      ? rng.pick(sample.producerIds, rng.int(0, 2))
      : [];

    if (hidden.length) {
      await this.preferences.addToBlacklist(record.id, {
        productIds: hidden,
        producerIds: hiddenProducers,
      });
    }

    const filters = rng.next() < QUICK_FILTER_SHARE
      ? rng.pick(QUICK_FILTER_TEMPLATES, rng.int(1, 3))
      : [];

    for (const input of filters) {
      await this.quickFilters.createForUser(record.id, input);
    }

    const owned = rng.next() < COLLECTION_SHARE
      ? rng.pick(sample.productIds, rng.int(2, 5))
      : [];

    let purchases = 0;

    for (const productId of owned) {
      purchases += await this.addCollectionRow(record.id, productId, rng);
    }

    return {
      favorites: favorites.length,
      blacklistProducts: hidden.length,
      blacklistProducers: hiddenProducers.length,
      quickFilters: filters.length,
      collectionRows: owned.length,
      purchases,
    };
  }

  /**
   * Adds one bottling to a user's collection with one or two purchases from
   * a free-text shop.
   *
   * @param userId - The owner.
   * @param productId - The bottling.
   * @param rng - The user's generator.
   * @returns How many purchases were written.
   */
  private async addCollectionRow(
    userId: ID,
    productId: ID,
    rng: SeededRandom,
  ): Promise<number> {
    const collectionId = await this.collection.createForUser(
      userId,
      productId,
      { rating: rng.int(5, 10) },
    );

    const count = rng.int(1, 2);

    for (let i = 0; i < count; i += 1) {
      await this.purchases.createForCollection(collectionId, {
        purchasedOn: LoadtestSeeder.isoDay(rng.int(1, 1000)),
        price: rng.int(8, 60) * 100,
        storeName: 'Duty free',
      });
    }

    return count;
  }

  /**
   * Reads the bottlings and live producers the preferences are drawn from.
   *
   * @returns The sample.
   */
  private async loadCatalogueSample(): Promise<LoadtestCatalogueSample> {
    const { data } = await this.products.list({
      limit: PRODUCT_SAMPLE,
      orderBy: 'id',
    });

    const { rows } = await this.producers.listForReview(
      KbStatus.AUTO,
      PRODUCER_SAMPLE,
      0,
    );

    return {
      productIds: data.map((product) => product.id),
      producerIds: rows.map((row) => row.id),
    };
  }

  /**
   * Writes the token file, readable by its owner only.
   *
   * @param file - The payload.
   */
  private async writeOutput(file: LoadtestUsersFile): Promise<void> {
    const target = path.resolve(this.options.out);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(file, null, 2), { mode: 0o600 });
  }

  /**
   * Prints what was created and how to undo it.
   *
   * @param records - The seeded users.
   * @param prefs - The preference tally, or null when none were seeded.
   */
  private report(
    records: LoadtestUserRecord[],
    prefs: LoadtestPrefsTally | null,
  ): void {
    console.log(`\nCreated ${records.length} user(s) with live sessions.`);

    if (prefs) {
      console.log(
        `Preferences: ${prefs.favorites} favorite(s), `
          + `${prefs.blacklistProducts} hidden bottling(s), `
          + `${prefs.blacklistProducers} hidden producer(s), `
          + `${prefs.quickFilters} quick filter(s), `
          + `${prefs.collectionRows} collection row(s) with `
          + `${prefs.purchases} purchase(s).`,
      );
    }

    console.log(`Tokens written to ${path.resolve(this.options.out)}`);
    console.log(
      'Remove everything with: pnpm loadtest:seed --cleanup '
        + `--prefix ${this.options.prefix}`,
    );
  }

  /**
   * Runs a task over a list, `CONCURRENCY` items at a time, preserving
   * order.
   *
   * @param items - The inputs.
   * @param task - The work per item.
   * @param onProgress - Called after each chunk with the count done so far.
   * @returns The results, aligned with the inputs.
   */
  private async forEachChunk<T, R>(
    items: T[],
    task: (item: T) => Promise<R>,
    onProgress?: (done: number) => void,
  ): Promise<R[]> {
    const results: R[] = [];

    for (const chunk of LoadtestSeeder.chunk(items, CONCURRENCY)) {
      const batch = await Promise.all(chunk.map(task));

      results.push(...batch);
      onProgress?.(results.length);
    }

    return results;
  }

  /**
   * Prints a progress line every `PROGRESS_EVERY` items and at the end.
   *
   * @param label - What is being counted.
   * @param done - Items finished.
   * @param total - Items in all.
   */
  private progress(label: string, done: number, total: number): void {
    if (done % PROGRESS_EVERY === 0 || done === total) {
      console.log(`  ${label} ${done}/${total}`);
    }
  }
}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments (without node and the script path).
 * @returns The parsed options.
 * @throws {Error} When a value is out of range.
 */
function parseArgs(argv: string[]): LoadtestSeedOptions {
  const value = (flag: string): string | undefined => {
    const next = argv[argv.indexOf(flag) + 1];

    return argv.includes(flag) && next && !next.startsWith('--')
      ? next
      : undefined;
  };

  const users = Number.parseInt(value('--users') ?? String(DEFAULT_USERS), 10);
  const prefix = value('--prefix') ?? DEFAULT_PREFIX;
  const ttl = value('--access-ttl');
  const accessTtl = ttl ? Number.parseInt(ttl, 10) : undefined;

  if (!Number.isInteger(users) || users < 1 || users > MAX_USERS) {
    throw new Error(`--users must be an integer between 1 and ${MAX_USERS}`);
  }

  if (prefix.length < MIN_PREFIX_LENGTH) {
    throw new Error(
      `--prefix must be at least ${MIN_PREFIX_LENGTH} characters`,
    );
  }

  if (
    accessTtl !== undefined && (!Number.isInteger(accessTtl) || accessTtl < 1)
  ) {
    throw new Error('--access-ttl must be a positive integer of seconds');
  }

  return {
    cleanup: argv.includes('--cleanup'),
    users,
    prefix,
    out: value('--out') ?? DEFAULT_OUT,
    accessTtl,
    prefs: argv.includes('--prefs'),
  };
}

/**
 * Seeds or removes the load-test population against whatever environment
 * the dotenv file describes.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  /**
   * Read by `JwtAccessConfig` when the context below builds it, so the
   * tokens are signed the ordinary way with a longer lifetime.
   */
  if (options.accessTtl) {
    process.env.JWT_ACCESS_EXPIRES = String(options.accessTtl);
  }

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(LoadtestSeedModule, {
    logger: ['error', 'warn'],
  });

  try {
    const seeder = new LoadtestSeeder(app, options);

    if (options.cleanup) {
      await seeder.cleanup();
    } else {
      await seeder.seed();
    }

    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
