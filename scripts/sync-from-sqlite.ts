import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdout } from 'node:process';

import BetterSqlite3 from 'better-sqlite3';
import { DataSource, EntityManager } from 'typeorm';

import { BrandEntity } from '~core/brand';
import { CountryEntity } from '~core/country';
import { FlavorEntity } from '~core/flavor';
import { PriceSnapshotEntity } from '~core/price-snapshot';
import { ProductEntity } from '~core/product';
import { StoreEntity } from '~core/store';
import { StoreConfigEntity } from '~core/store-config';
import { SyncLogEntity } from '~core/sync-log';
import { TypeEntity } from '~core/type';
import { BrandUtils, ProductNameUtils } from '~utils';

import datasource from '../typeorm.config';

/**
 * Row shapes read from the legacy SQLite database. These mirror the legacy
 * `db.py` schema and are local to this migration script.
 */
interface LegacyCountry {
  code: string;
  name_ua: string;
  icon: string | null;
  created_at: string;
}

interface LegacyStore {
  slug: string;
  name: string;
  base_url: string;
  color: string | null;
  active: number;
  created_at: string | null;
}

interface LegacyStoreConfig {
  slug: string;
  tier: number;
  delay_from: number;
  delay_to: number;
  needs_browser: number;
  retail_chain: string | null;
  category: string | null;
}

interface LegacyProduct {
  id: number;
  slug: string;
  store_sku: string;
  url: string;
  brand: string | null;
  name: string;
  age_years: number | null;
  abv: number | null;
  volume_ml: number | null;
  whisky_type: string | null;
  country_code: string | null;
  flavor_tags_json: string;
  first_seen: string;
  last_seen: string;
}

interface LegacySnapshot {
  product_id: number;
  captured_date: string;
  price: number;
  old_price: number | null;
  currency: string;
  in_stock: number;
  promo: number;
}

interface LegacyUser {
  id: number;
  email: string | null;
  username: string | null;
  password_hash: string;
  is_admin: number;
  is_active: number;
  created_at: string;
  last_active_at: string | null;
}

interface LegacySyncLog {
  slug: string;
  added: number;
  removed: number;
  updated: number;
  total: number;
  success: number | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

const ALL_TABLES = [
  'country',
  'store',
  'store_config',
  'product',
  'price_snapshot',
  'user',
  'sync_log',
];

// Postgres caps a statement at 65535 bind parameters; chunk well under that.
const UPSERT_CHUNK = 500;
const INSERT_CHUNK = 1000;

/**
 * Columns refreshed when an existing product is re-synced. Absent by design:
 * `name`, `countryId`, `typeId`, `age`, `abv`, `volumeMl` — these are set once
 * on insert and thereafter owned by manual edits, so a re-sync must not clobber
 * them. Only `brandId`, `url`, `nameOrig` and the seen dates keep updating.
 */
const PRODUCT_CONFLICT_OVERWRITE = [
  'url',
  'nameOrig',
  'brandId',
  'firstSeen',
  'lastSeen',
];

/**
 * Idempotent, re-runnable synchronisation of the legacy SQLite database into
 * the Postgres schema owned by this Node app. Upserts by natural key and
 * resolves every foreign key by natural key, so legacy integer ids are never
 * carried over. Safe to run repeatedly as a periodic sync.
 */
export class SqliteToPgSync {
  private readonly manager: EntityManager;

  public constructor(
    private readonly ds: DataSource,
    private readonly sqlite: BetterSqlite3.Database,
    private readonly only: Set<string> | null,
  ) {
    this.manager = ds.manager;
  }

  /**
   * Runs every requested table sync in dependency order (parents first).
   *
   * @returns Resolves once all requested tables have been synced.
   */
  public async run(): Promise<void> {
    await this.syncCountries();
    await this.syncLookups();
    await this.syncStores();
    await this.syncStoreConfig();
    await this.syncProducts();
    await this.syncSnapshots();
    await this.syncUsers();
    await this.syncSyncLog();
  }

  /**
   * Prints the source row counts per legacy table without writing anything.
   *
   * @returns Resolves once the counts have been printed.
   */
  public dryRun(): void {
    const tables = [
      'countries',
      'stores',
      'store_config',
      'products',
      'price_snapshots',
      'users',
      'sync_log',
    ];

    stdout.write('Dry run — legacy source counts:\n');

    tables.forEach((table) => {
      const row = this.sqlite
        .prepare(`SELECT count(*) AS c FROM ${table}`)
        .get() as { c: number };

      stdout.write(`  ${table}: ${row.c.toString()}\n`);
    });
  }

  /**
   * Determines whether a target table should be processed in this run.
   *
   * @param name - Target Postgres table name.
   * @returns `true` when no filter is set or the table is in the filter.
   */
  private wants(name: string): boolean {
    return !this.only || this.only.has(name);
  }

  /**
   * Loads a natural-key → uuid map from a Postgres table.
   *
   * @param table - Target table name.
   * @param keyColumn - Column holding the natural key.
   * @returns Map from the natural-key value to the row's uuid.
   */
  private async loadMap(
    table: string,
    keyColumn: string,
  ): Promise<Map<string, string>> {
    const rows = await this.ds.query(
      `SELECT id, "${keyColumn}" AS k FROM "${table}"`,
    ) as { id: string; k: string }[];

    return new Map(rows.map((row) => [String(row.k), row.id]));
  }

  /**
   * Converts a legacy ISO timestamp string into a Date, or undefined so the
   * database default applies.
   *
   * @param value - Legacy ISO-8601 string or null.
   * @returns A Date instance, or undefined when the input is empty.
   */
  private toDate(value: string | null): Date | undefined {
    return value ? new Date(value) : undefined;
  }

  /**
   * Upserts the legacy countries into the `country` table (key: code).
   *
   * @returns Resolves once countries are synced.
   */
  private async syncCountries(): Promise<void> {
    if (!this.wants('country')) {
      return;
    }

    const rows = this.sqlite
      .prepare('SELECT code, name_ua, icon, created_at FROM countries')
      .all() as LegacyCountry[];

    const entities = rows.map((row) => ({
      code: row.code,
      nameUa: row.name_ua,
      icon: row.icon ?? undefined,
      createdAt: this.toDate(row.created_at),
    }));

    await this.upsert(CountryEntity, entities, ['code']);

    stdout.write(`country: ${entities.length.toString()} upserted\n`);
  }

  /**
   * Upserts the distinct brands, whisky types, and flavor tags referenced by
   * legacy products into their lookup tables (key: name). Brand names are run
   * through `BrandUtils.canonical` first, so the case/whitespace/Cyrillic
   * variants different stores emit collapse onto a single lookup row.
   *
   * @returns Resolves once the lookup tables are synced.
   */
  private async syncLookups(): Promise<void> {
    if (!this.wants('product')) {
      return;
    }

    const rows = this.sqlite
      .prepare('SELECT brand, whisky_type, flavor_tags_json FROM products')
      .all() as Pick<
        LegacyProduct,
        'brand' | 'whisky_type' | 'flavor_tags_json'
      >[];

    const brands = new Set<string>();
    const types = new Set<string>();
    const flavors = new Set<string>();

    rows.forEach((row) => {
      const brand = BrandUtils.canonical(row.brand);

      if (brand) {
        brands.add(brand);
      }

      if (row.whisky_type) {
        types.add(row.whisky_type);
      }

      this.parseFlavors(row.flavor_tags_json).forEach((tag) =>
        flavors.add(tag)
      );
    });

    await this.upsert(
      BrandEntity,
      [...brands].map((name) => ({ name })),
      ['name'],
    );

    await this.upsert(
      TypeEntity,
      [...types].map((name) => ({ name })),
      ['name'],
    );

    await this.upsert(
      FlavorEntity,
      [...flavors].map((name) => ({ name })),
      ['name'],
    );

    stdout.write(
      `lookups: ${brands.size.toString()} brands, `
        + `${types.size.toString()} types, `
        + `${flavors.size.toString()} flavors\n`,
    );
  }

  /**
   * Upserts the legacy stores into the `store` table (key: slug), preserving
   * the legacy creation date.
   *
   * @returns Resolves once stores are synced.
   */
  private async syncStores(): Promise<void> {
    if (!this.wants('store')) {
      return;
    }

    const rows = this.sqlite
      .prepare(
        'SELECT slug, name, base_url, color, active, created_at FROM stores',
      )
      .all() as LegacyStore[];

    const entities = rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      baseUrl: row.base_url,
      color: row.color ?? undefined,
      active: Boolean(row.active),
      createdAt: this.toDate(row.created_at),
    }));

    await this.upsert(StoreEntity, entities, ['slug']);

    stdout.write(`store: ${entities.length.toString()} upserted\n`);
  }

  /**
   * Upserts the legacy store scrape configs into `store_config`, resolving the
   * owning store by slug (key: storeId).
   *
   * @returns Resolves once store configs are synced.
   */
  private async syncStoreConfig(): Promise<void> {
    if (!this.wants('store_config')) {
      return;
    }

    const slugMap = await this.loadMap('store', 'slug');

    const rows = this.sqlite
      .prepare(
        `SELECT s.slug AS slug, c.tier, c.delay_from, c.delay_to,
                c.needs_browser, c.retail_chain, c.category
         FROM store_config c JOIN stores s ON s.id = c.store_id`,
      )
      .all() as LegacyStoreConfig[];

    const entities = rows
      .filter((row) => slugMap.has(row.slug))
      .map((row) => ({
        storeId: slugMap.get(row.slug)!,
        tier: row.tier,
        delayFrom: row.delay_from,
        delayTo: row.delay_to,
        needsBrowser: Boolean(row.needs_browser),
        retailChain: row.retail_chain ?? undefined,
        category: row.category ?? undefined,
      }));

    await this.upsert(StoreConfigEntity, entities, ['storeId']);

    stdout.write(`store_config: ${entities.length.toString()} upserted\n`);
  }

  /**
   * Upserts the legacy products into `product`, resolving store/brand/type/
   * country foreign keys by natural key, then rebuilds the `product_flavor`
   * many-to-many links (key: storeId + sku).
   *
   * @returns Resolves once products and their flavor links are synced.
   */
  private async syncProducts(): Promise<void> {
    if (!this.wants('product')) {
      return;
    }

    const [slugMap, brandMap, typeMap, countryMap, flavorMap] = await Promise
      .all([
        this.loadMap('store', 'slug'),
        this.loadMap('brand', 'name'),
        this.loadMap('type', 'name'),
        this.loadMap('country', 'code'),
        this.loadMap('flavor', 'name'),
      ]);

    const rows = this.sqlite
      .prepare(
        `SELECT p.id, s.slug AS slug, p.store_sku, p.url, p.brand, p.name,
                p.age_years, p.abv, p.volume_ml, p.whisky_type,
                c.code AS country_code, p.flavor_tags_json,
                p.first_seen, p.last_seen
         FROM products p
         JOIN stores s ON s.id = p.store_id
         LEFT JOIN countries c ON c.id = p.country_id`,
      )
      .all() as LegacyProduct[];

    const entities = rows
      .filter((row) => slugMap.has(row.slug))
      .map((row) => {
        const brand = BrandUtils.canonical(row.brand);

        return {
          storeId: slugMap.get(row.slug)!,
          sku: row.store_sku,
          url: row.url,
          name: ProductNameUtils.clean(row.name) ?? undefined,
          nameOrig: row.name,
          age: row.age_years ?? undefined,
          abv: row.abv ?? undefined,
          volumeMl: row.volume_ml ?? undefined,
          brandId: brand ? brandMap.get(brand) : undefined,
          typeId: row.whisky_type ? typeMap.get(row.whisky_type) : undefined,
          countryId: row.country_code
            ? countryMap.get(row.country_code)
            : undefined,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        };
      });

    await this.upsertProducts(entities);

    const productMap = await this.loadProductMap();

    await this.syncProductFlavors(rows, slugMap, productMap, flavorMap);

    stdout.write(`product: ${entities.length.toString()} upserted\n`);
  }

  /**
   * Upserts products, but never overwrites `name` on conflict: `name` is
   * cleaned once on insert and thereafter owned by manual edits. Everything
   * else — including the raw `nameOrig` — is refreshed on every sync. Chunked
   * to stay under the Postgres bind-parameter limit.
   *
   * @param rows - Plain product rows to upsert (keyed by storeId + sku).
   * @returns Resolves once every batch has been written.
   */
  private async upsertProducts(rows: object[]): Promise<void> {
    const batches = this.chunk(rows, UPSERT_CHUNK);

    for (const batch of batches) {
      await this.manager
        .createQueryBuilder()
        .insert()
        .into(ProductEntity)
        .values(batch as never)
        .orUpdate(PRODUCT_CONFLICT_OVERWRITE, ['storeId', 'sku'])
        .execute();
    }
  }

  /**
   * Loads a `storeId|sku` → product uuid map for every product in Postgres.
   *
   * @returns Map from the composite product key to its uuid.
   */
  private async loadProductMap(): Promise<Map<string, string>> {
    const rows = await this.ds.query(
      'SELECT id, "storeId", sku FROM "product"',
    ) as { id: string; storeId: string; sku: string }[];

    return new Map(
      rows.map((row) => [`${row.storeId}|${row.sku}`, row.id]),
    );
  }

  /**
   * Rebuilds the `product_flavor` links for the given legacy products from
   * their parsed flavor tags. Insert-only with conflict-ignore, so it is safe
   * to re-run.
   *
   * @param rows - Legacy product rows carrying `flavor_tags_json`.
   * @param slugMap - store slug → uuid map.
   * @param productMap - `storeId|sku` → product uuid map.
   * @param flavorMap - flavor name → uuid map.
   * @returns Resolves once the links have been inserted.
   */
  private async syncProductFlavors(
    rows: LegacyProduct[],
    slugMap: Map<string, string>,
    productMap: Map<string, string>,
    flavorMap: Map<string, string>,
  ): Promise<void> {
    const links: [string, string][] = [];

    rows.forEach((row) => {
      const storeId = slugMap.get(row.slug);
      if (!storeId) {
        return;
      }

      const productId = productMap.get(`${storeId}|${row.store_sku}`);
      if (!productId) {
        return;
      }

      this.parseFlavors(row.flavor_tags_json).forEach((tag) => {
        const flavorId = flavorMap.get(tag);

        if (flavorId) {
          links.push([productId, flavorId]);
        }
      });
    });

    const batches = this.chunk(links, INSERT_CHUNK);

    for (const batch of batches) {
      await this.manager
        .createQueryBuilder()
        .insert()
        .into('product_flavor', ['productId', 'flavorId'])
        .values(
          batch.map(([productId, flavorId]) => ({ productId, flavorId })),
        )
        .orIgnore()
        .execute();
    }
  }

  /**
   * Inserts legacy price snapshots into `price_snapshot`, resolving the owning
   * product via the legacy product id. `createdAt` is set from the legacy
   * `captured_date`; existing `(productId, createdAt)` rows are skipped so the
   * sync is idempotent.
   *
   * @returns Resolves once new snapshots are inserted.
   */
  private async syncSnapshots(): Promise<void> {
    if (!this.wants('price_snapshot')) {
      return;
    }

    const legacyToProduct = await this.loadLegacyProductMap();
    const existing = await this.loadExistingSnapshots();

    const rows = this.sqlite
      .prepare(
        `SELECT product_id, captured_date, price, old_price, currency,
                in_stock, promo
         FROM price_snapshots`,
      )
      .all() as LegacySnapshot[];

    const entities = rows
      .map((row) => {
        const productId = legacyToProduct.get(row.product_id);

        if (!productId) {
          return null;
        }

        const createdAt = new Date(`${row.captured_date}T00:00:00Z`);
        const key = `${productId}|${createdAt.toISOString()}`;

        if (existing.has(key)) {
          return null;
        }

        return {
          productId,
          price: row.price,
          oldPrice: row.old_price ?? undefined,
          currency: row.currency,
          inStock: Boolean(row.in_stock),
          promo: Boolean(row.promo),
          createdAt,
        };
      })
      .filter((entity): entity is NonNullable<typeof entity> =>
        entity !== null
      );

    const batches = this.chunk(entities, INSERT_CHUNK);

    for (const batch of batches) {
      await this.manager.insert(PriceSnapshotEntity, batch);
    }

    stdout.write(`price_snapshot: ${entities.length.toString()} inserted\n`);
  }

  /**
   * Builds a legacy product id → Postgres product uuid map by joining the
   * legacy product keys to their synced rows.
   *
   * @returns Map from the legacy integer product id to the product uuid.
   */
  private async loadLegacyProductMap(): Promise<Map<number, string>> {
    const productMap = await this.loadProductMap();
    const slugMap = await this.loadMap('store', 'slug');

    const rows = this.sqlite
      .prepare(
        `SELECT p.id, s.slug AS slug, p.store_sku
         FROM products p JOIN stores s ON s.id = p.store_id`,
      )
      .all() as { id: number; slug: string; store_sku: string }[];

    const map = new Map<number, string>();

    rows.forEach((row) => {
      const storeId = slugMap.get(row.slug);

      if (!storeId) {
        return;
      }

      const productId = productMap.get(`${storeId}|${row.store_sku}`);

      if (productId) {
        map.set(row.id, productId);
      }
    });

    return map;
  }

  /**
   * Loads the set of existing `(productId, createdAt)` snapshot keys so that
   * re-runs do not duplicate rows.
   *
   * @returns Set of `productId|ISO-createdAt` keys already in Postgres.
   */
  private async loadExistingSnapshots(): Promise<Set<string>> {
    const rows = await this.ds.query(
      'SELECT "productId", "createdAt" FROM "price_snapshot"',
    ) as { productId: string; createdAt: Date }[];

    return new Set(
      rows.map(
        (row) => `${row.productId}|${new Date(row.createdAt).toISOString()}`,
      ),
    );
  }

  /**
   * Migrates legacy users into `user`, writing the raw pbkdf2 hash verbatim
   * (bypassing the argon2 column transformer) so the dual-hash login flow can
   * verify and re-hash it later. Existing users are updated in place without
   * touching their password.
   *
   * @returns Resolves once users are synced.
   */
  private async syncUsers(): Promise<void> {
    if (!this.wants('user')) {
      return;
    }

    const rows = this.sqlite
      .prepare(
        `SELECT id, email, username, password_hash, is_admin, is_active,
                created_at, last_active_at
         FROM users`,
      )
      .all() as LegacyUser[];

    let created = 0;

    for (const row of rows) {
      const wasCreated = await this.syncUser(row);

      if (wasCreated) {
        created += 1;
      }
    }

    stdout.write(
      `user: ${created.toString()} created, `
        + `${(rows.length - created).toString()} existing\n`,
    );
  }

  /**
   * Inserts or updates a single legacy user, matched by email (or name when
   * the user has no email). Never overwrites an existing password hash.
   *
   * @param row - Legacy user row.
   * @returns `true` when a new user was created, `false` when one was updated.
   */
  private async syncUser(row: LegacyUser): Promise<boolean> {
    const name = row.username ?? row.email ?? `user_${row.id.toString()}`;
    const email = row.email ?? null;
    const admin = Boolean(row.is_admin);
    const active = Boolean(row.is_active);
    const lastActiveAt = row.last_active_at;

    const found = (email
      ? await this.ds.query(
        `SELECT id, admin, active, "lastActiveAt" FROM "user"
         WHERE email = $1`,
        [email],
      )
      : await this.ds.query(
        `SELECT id, admin, active, "lastActiveAt" FROM "user"
         WHERE name = $1`,
        [name],
      )) as {
        id: string;
        admin: boolean;
        active: boolean;
        lastActiveAt: Date | null;
      }[];

    if (found.length) {
      await this.updateUserIfChanged(found[0], admin, active, lastActiveAt);

      return false;
    }

    await this.ds.query(
      `INSERT INTO "user"
         ("name", "email", "password", "admin", "active",
          "lastActiveAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp)`,
      [
        name,
        email,
        row.password_hash,
        admin,
        active,
        lastActiveAt,
        row.created_at,
      ],
    );

    return true;
  }

  /**
   * Updates a user's mutable fields only when at least one differs, keeping
   * re-runs free of spurious `updatedAt` churn. Never touches the password.
   *
   * @param current - The existing user row from Postgres.
   * @param admin - Desired admin flag from the legacy row.
   * @param active - Desired active flag from the legacy row.
   * @param lastActiveAt - Desired last-active timestamp (ISO string or null).
   * @returns Resolves once any needed update is applied.
   */
  private async updateUserIfChanged(
    current: {
      id: string;
      admin: boolean;
      active: boolean;
      lastActiveAt: Date | null;
    },
    admin: boolean,
    active: boolean,
    lastActiveAt: string | null,
  ): Promise<void> {
    const currentLast = current.lastActiveAt
      ? new Date(current.lastActiveAt).toISOString()
      : null;

    const desiredLast = lastActiveAt
      ? new Date(lastActiveAt).toISOString()
      : null;

    const unchanged = current.admin === admin
      && current.active === active
      && currentLast === desiredLast;

    if (unchanged) {
      return;
    }

    await this.ds.query(
      `UPDATE "user" SET admin = $2, active = $3,
              "lastActiveAt" = $4::timestamp WHERE id = $1`,
      [current.id, admin, active, lastActiveAt],
    );
  }

  /**
   * Inserts legacy sync-log rows into `sync_log`, resolving the store by slug
   * and mapping the legacy timestamps onto `createdAt`/`updatedAt`/
   * `finishedAt`. Existing `(storeId, createdAt)` rows are skipped.
   *
   * @returns Resolves once new sync-log rows are inserted.
   */
  private async syncSyncLog(): Promise<void> {
    if (!this.wants('sync_log')) {
      return;
    }

    const slugMap = await this.loadMap('store', 'slug');
    const existing = await this.loadExistingSyncLogs();

    const rows = this.sqlite
      .prepare(
        `SELECT s.slug AS slug, l.added, l.removed, l.updated, l.total,
                l.success, l.error, l.started_at, l.updated_at, l.finished_at
         FROM sync_log l JOIN stores s ON s.id = l.store_id`,
      )
      .all() as LegacySyncLog[];

    let inserted = 0;

    for (const row of rows) {
      const wasInserted = await this.syncSyncLogRow(row, slugMap, existing);

      if (wasInserted) {
        inserted += 1;
      }
    }

    stdout.write(`sync_log: ${inserted.toString()} inserted\n`);
  }

  /**
   * Loads existing `(storeId, createdAt)` sync-log keys to keep re-runs
   * idempotent.
   *
   * @returns Set of `storeId|ISO-createdAt` keys already in Postgres.
   */
  private async loadExistingSyncLogs(): Promise<Set<string>> {
    const rows = await this.ds.query(
      'SELECT "storeId", "createdAt" FROM "sync_log"',
    ) as { storeId: string; createdAt: Date }[];

    return new Set(
      rows.map(
        (row) => `${row.storeId}|${new Date(row.createdAt).toISOString()}`,
      ),
    );
  }

  /**
   * Inserts one legacy sync-log row if its store resolves and it is not
   * already present.
   *
   * @param row - Legacy sync-log row joined with its store slug.
   * @param slugMap - store slug → uuid map.
   * @param existing - Set of already-present `storeId|createdAt` keys.
   * @returns `true` when a row was inserted, `false` otherwise.
   */
  private async syncSyncLogRow(
    row: LegacySyncLog,
    slugMap: Map<string, string>,
    existing: Set<string>,
  ): Promise<boolean> {
    const storeId = slugMap.get(row.slug);

    if (!storeId) {
      return false;
    }

    const createdAt = new Date(row.started_at);
    const key = `${storeId}|${createdAt.toISOString()}`;

    if (existing.has(key)) {
      return false;
    }

    await this.manager.insert(SyncLogEntity, {
      storeId,
      added: row.added,
      removed: row.removed,
      updated: row.updated,
      total: row.total,
      success: row.success === null ? undefined : Boolean(row.success),
      error: row.error ?? undefined,
      finishedAt: this.toDate(row.finished_at),
      createdAt,
      updatedAt: new Date(row.updated_at),
    });

    return true;
  }

  /**
   * Upserts a batch of plain entity objects, skipping the write entirely when
   * the batch is empty or no values changed.
   *
   * @param entity - Target entity class.
   * @param rows - Plain objects to upsert.
   * @param conflictPaths - Columns forming the conflict target.
   * @returns Resolves once the batch is upserted.
   */
  private async upsert<T>(
    entity: { new(): T },
    rows: object[],
    conflictPaths: string[],
  ): Promise<void> {
    const batches = this.chunk(rows, UPSERT_CHUNK);

    for (const batch of batches) {
      await this.manager.upsert(entity, batch as never, {
        conflictPaths,
        skipUpdateIfNoValuesChanged: true,
      });
    }
  }

  /**
   * Splits an array into fixed-size chunks to keep each SQL statement within
   * the Postgres bind-parameter limit.
   *
   * @param items - The items to split.
   * @param size - Maximum items per chunk.
   * @returns An array of chunks, each at most `size` items long.
   */
  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];

    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }

    return out;
  }

  /**
   * Parses a legacy `flavor_tags_json` blob into a list of tag strings.
   *
   * @param json - JSON-encoded array of flavor tags (may be empty).
   * @returns The parsed, non-empty string tags; empty on parse failure.
   */
  private parseFlavors(json: string): string[] {
    try {
      const parsed = JSON.parse(json || '[]') as unknown;

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(
        (tag): tag is string => typeof tag === 'string' && tag.length > 0,
      );
    } catch {
      return [];
    }
  }
}

/**
 * Resolves the CLI arguments into a config: SQLite path, dry-run flag, and an
 * optional table filter.
 *
 * @returns The parsed run configuration.
 */
const parseArgs = (): {
  sqlitePath: string;
  dryRun: boolean;
  only: Set<string> | null;
} => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const tablesArg = args.find((arg) => arg.startsWith('--tables='));
  const only = tablesArg
    ? new Set(tablesArg.slice('--tables='.length).split(','))
    : null;

  /**
   * SQLite source path: an explicit positional arg wins, then the
   * `LEGACY_SQLITE_PATH` env var, then the default `whisky.db` in the `be`
   * project root. Existence is verified in `main` before any work runs.
   */
  const positional = args.find((arg) => !arg.startsWith('--'));
  const sqlitePath = positional
    ?? process.env.LEGACY_SQLITE_PATH
    ?? resolve(__dirname, '..', 'whisky.db');

  return { sqlitePath, dryRun, only };
};

/**
 * Entry point: opens the legacy SQLite file and the Postgres data source, runs
 * the sync (or a dry-run), then tears both down.
 *
 * @returns Resolves once the sync has finished and connections are closed.
 */
const main = async (): Promise<void> => {
  const { sqlitePath, dryRun, only } = parseArgs();

  if (!existsSync(sqlitePath)) {
    throw new Error(
      `SQLite file not found: ${sqlitePath} — pass a path as the first `
        + 'positional argument or set LEGACY_SQLITE_PATH',
    );
  }

  if (only) {
    const unknown = [...only].filter((name) => !ALL_TABLES.includes(name));

    if (unknown.length) {
      throw new Error(`Unknown --tables values: ${unknown.join(', ')}`);
    }
  }

  stdout.write(`Reading legacy SQLite: ${sqlitePath}\n`);

  const sqlite = new BetterSqlite3(sqlitePath, { readonly: true });
  const ds = await datasource.initialize();

  try {
    const sync = new SqliteToPgSync(ds, sqlite, only);

    if (dryRun) {
      sync.dryRun();

      return;
    }

    await sync.run();

    stdout.write('Sync complete.\n');
  } finally {
    await ds.destroy();

    sqlite.close();
  }
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
