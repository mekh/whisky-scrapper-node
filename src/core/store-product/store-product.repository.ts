import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  ID,
  MetaCountry,
  ReportCurrentRow,
  ReportFilter,
  StoreProductRef,
  StoreProductUpsertInput,
  StoreProductUpsertResult,
} from '~types';

import { StoreProductEntity } from './store-product.entity';

// Latest snapshot per store offer (+ the immediately previous price), joined to
// the bottling it is an offer of and to the lookup tables. `rn = 1` keeps only
// the newest snapshot; `LEAD` reaches the one before it. One result row is one
// store's offer: `id`, `sku`, `url`, `nameOrig`, `inStock` and `firstSeen` are
// the offer's, while the name, specs, brand, type, country and flavors are the
// bottling's and so read identically for every store carrying it. Numeric
// columns are cast to float8 and dates to text so the raw driver returns JS
// numbers / `YYYY-MM-DD` strings rather than strings/Dates.
const CURRENT_SQL = `
  WITH ranked AS (
    SELECT s."storeProductId",
           s.price, s."oldPrice", s.currency, s.promo,
           s."createdAt"::date AS captured,
           ROW_NUMBER() OVER w AS rn,
           LEAD(s.price) OVER w AS prev
    FROM price_snapshot s
    WINDOW w AS (PARTITION BY s."storeProductId" ORDER BY s."createdAt" DESC)
  )
  SELECT sp.id, sp."productId", sp.sku, sp.url, sp."nameOrig",
         sp."firstSeen"::text AS "firstSeen", sp."inStock",
         p.name, p.age, p.abv, p."volumeMl",
         st.slug AS "storeSlug", st.name AS "storeName",
         b.name AS brand, t.name AS type,
         c.code AS "countryCode", c."nameUa" AS "countryName",
         c.icon AS "countryIcon",
         r.price::float8 AS price,
         r."oldPrice"::float8 AS "oldPrice",
         r.currency, r.promo,
         r.prev::float8 AS "previousPrice",
         r.captured::text AS "capturedDate",
         COALESCE((
           SELECT array_agg(f.name ORDER BY f.name)
           FROM product_flavor pf
           JOIN flavor f ON f.id = pf."flavorId"
           WHERE pf."productId" = p.id
         ), '{}') AS flavors
  FROM ranked r
  JOIN store_product sp ON sp.id = r."storeProductId"
  JOIN product p ON p.id = sp."productId"
  JOIN store st ON st.id = sp."storeId"
  LEFT JOIN brand b ON b.id = p."brandId"
  LEFT JOIN type t ON t.id = p."typeId"
  LEFT JOIN country c ON c.id = p."countryId"
  WHERE r.rn = 1
`;

// A SKU the store has not listed before. `productId` appears in the INSERT and
// nowhere in the update clause: that omission is what makes the offer's link to
// a bottling durable, so a manual relink is never undone by the next sync.
const UPSERT_SQL = `
  INSERT INTO store_product
     ("storeId", "productId", sku, url, "nameOrig", "firstSeen", "lastSeen")
   VALUES ($1, $2, $3, $4, $5, $6, $6)
   ON CONFLICT ("storeId", sku) DO UPDATE SET
     url = EXCLUDED.url,
     "nameOrig" = EXCLUDED."nameOrig",
     "inStock" = true,
     "lastSeen" = EXCLUDED."lastSeen",
     "updatedAt" = now()
   RETURNING id, "productId", (xmax = 0) AS "isNew"
`;

// A SKU already on file: refresh what the listing states and leave the link
// alone. Returns the stored `productId` so the caller can still contribute to
// the bottling without having resolved a key for it.
const TOUCH_SQL = `
  UPDATE store_product SET
    url = $3,
    "nameOrig" = $4,
    "inStock" = true,
    "lastSeen" = $5,
    "updatedAt" = now()
  WHERE "storeId" = $1 AND sku = $2
  RETURNING id, "productId"
`;

@TypeormRepository(StoreProductEntity)
export class StoreProductRepository extends BaseRepository<StoreProductEntity> {
  /**
   * Inserts or refreshes one store's offer, keyed on `(storeId, sku)`.
   *
   * Which statement runs is decided by `input.productId`: a resolved id means
   * the caller believes the SKU is new and supplies the bottling to link it to,
   * while null means the SKU is already stored and its existing link must be
   * left exactly as it is. The insert path doubles as the fallback — a SKU that
   * disappeared between the caller's lookup and this write is inserted rather
   * than silently skipped.
   *
   * @param input - The offer to write.
   * @returns The offer id, the bottling it is linked to and whether the row was
   *   newly inserted, or null when a touch matched no row.
   */
  public async upsertFromScrape(
    input: StoreProductUpsertInput,
  ): Promise<StoreProductUpsertResult | null> {
    if (input.productId === null) {
      const touched = await this.query(TOUCH_SQL, [
        input.storeId,
        input.sku,
        input.url,
        input.nameOrig,
        input.seenOn,
      ]) as [{ id: ID; productId: ID }[], number];

      const row = touched[0][0];

      if (!row) {
        return null;
      }

      return { id: row.id, productId: row.productId, isNew: false };
    }

    const rows = await this.query(UPSERT_SQL, [
      input.storeId,
      input.productId,
      input.sku,
      input.url,
      input.nameOrig,
      input.seenOn,
    ]) as StoreProductUpsertResult[];

    return rows[0];
  }

  /**
   * SKUs a store already lists, whatever their stock state. The enrichment
   * passes use it to tell a genuinely new listing from one the catalogue has
   * already been asked about.
   *
   * @param storeId - Store id.
   * @returns The set of SKUs already stored for the store.
   */
  public async existingSkus(storeId: ID): Promise<Set<string>> {
    const rows = await this.query(
      'SELECT sku FROM store_product WHERE "storeId" = $1',
      [storeId],
    ) as { sku: string }[];

    return new Set(rows.map((row) => row.sku));
  }

  /**
   * Flags a store's offers as out of stock by SKU (the items the latest
   * listing explicitly returned as unavailable). The rows and their price
   * history are kept. Flags nothing when the list is empty.
   *
   * @param storeId - Store id.
   * @param skus - SKUs to flag.
   * @returns How many offers were flagged.
   */
  public async markOutOfStockBySkus(
    storeId: ID,
    skus: string[],
  ): Promise<number> {
    if (!skus.length) {
      return 0;
    }

    const result = await this.createQueryBuilder()
      .update(StoreProductEntity)
      .set({ inStock: false })
      .where('"storeId" = :storeId', { storeId })
      .andWhere('"inStock"')
      .andWhere('sku = ANY(:skus)', { skus })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Flags every in-stock offer of a store as out of stock except the given
   * SKUs (the sweep after a full listing: whatever the run did not see in
   * stock is no longer available). The rows and their price history are kept.
   *
   * @param storeId - Store id.
   * @param keepSkus - SKUs seen in stock this run, to leave untouched.
   * @returns How many offers were flagged.
   */
  public async markOutOfStockExcept(
    storeId: ID,
    keepSkus: string[],
  ): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(StoreProductEntity)
      .set({ inStock: false })
      .where('"storeId" = :storeId', { storeId })
      .andWhere('"inStock"')
      .andWhere('NOT (sku = ANY(:keepSkus))', { keepSkus })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Loads the current state (latest snapshot + previous price + joins) of
   * every in-stock offer matching the filter — out-of-stock offers are always
   * excluded here. Filtering runs in SQL; report-specific logic and pagination
   * are applied by the caller.
   *
   * Note which side each predicate lands on: `stores` filters the offer, while
   * volume, country, type and flavors filter the bottling, so every store's
   * row for one whisky now answers them identically. The name search is the
   * one that straddles both — the canonical name holds brand + expression, so
   * the descriptors a user may search for survive only in the offer's raw name.
   *
   * @param filter - The report filter; empty fields mean no constraint.
   * @returns One row per matching offer.
   */
  public async findCurrentRows(
    filter: ReportFilter,
  ): Promise<ReportCurrentRow[]> {
    const types = filter.types?.filter((name) => name !== 'unknown') ?? null;
    const hasUnknownType = filter.types?.includes('unknown') ?? false;

    const params = [
      filter.stores?.length ? filter.stores : null,
      filter.minPrice ?? null,
      filter.maxPrice ?? null,
      filter.minVolume ?? null,
      filter.maxVolume ?? null,
      filter.countries?.length
        ? filter.countries.map((code) => code.toLowerCase())
        : null,
      filter.name ?? null,
      filter.types?.length ? types : null,
      hasUnknownType,
      filter.flavors?.length ? filter.flavors : null,
      filter.excludeFlavors?.length ? filter.excludeFlavors : null,
    ];

    const sql = `${CURRENT_SQL}
      AND sp."inStock"
      AND ($1::text[] IS NULL OR st.slug = ANY($1))
      AND ($2::float8 IS NULL OR r.price >= $2)
      AND ($3::float8 IS NULL OR r.price <= $3)
      AND ($4::int IS NULL OR p."volumeMl" >= $4)
      AND ($5::int IS NULL OR p."volumeMl" <= $5)
      AND ($6::text[] IS NULL OR lower(c.code) = ANY($6))
      AND ($7::text IS NULL OR p.name ILIKE '%' || $7 || '%'
           OR sp."nameOrig" ILIKE '%' || $7 || '%')
      AND ($8::text[] IS NULL OR t.name = ANY($8)
           OR ($9 AND p."typeId" IS NULL))
      AND ($10::text[] IS NULL OR EXISTS (
        SELECT 1 FROM product_flavor pf
        JOIN flavor f ON f.id = pf."flavorId"
        WHERE pf."productId" = p.id AND f.name = ANY($10)))
      AND ($11::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM product_flavor pf
        JOIN flavor f ON f.id = pf."flavorId"
        WHERE pf."productId" = p.id AND f.name = ANY($11)))
    `;

    return this.query(sql, params) as Promise<ReportCurrentRow[]>;
  }

  /**
   * Loads the current row for a single offer by id. Unlike the list query,
   * out-of-stock offers are returned too (with `inStock: false`) so their price
   * history stays reachable.
   *
   * @param id - Store-offer id.
   * @returns The offer's current row, or null when it has no snapshot.
   */
  public async findCurrentRowById(id: ID): Promise<ReportCurrentRow | null> {
    const rows = await this.query(
      `${CURRENT_SQL} AND sp.id = $1`,
      [id],
    ) as ReportCurrentRow[];

    return rows[0] ?? null;
  }

  /**
   * Resolves an id that may be either a store offer or a bottling to one
   * concrete offer.
   *
   * The report hands out offer ids, so that is the hot path (rank 0). A
   * canonical id resolves to a representative offer instead — the in-stock one
   * seen most recently, deliberately the same ordering the name search uses, so
   * the two agree on which store's row stands for a bottling. There is no
   * ambiguity between the two id spaces: the offers kept the ids they had
   * before the split and the bottlings were issued fresh ones.
   *
   * @param id - A store-offer id or a canonical product id.
   * @returns The resolved offer, or null when the id matches neither.
   */
  public async findOfferRefById(id: ID): Promise<StoreProductRef | null> {
    const rows = await this.query(
      `WITH candidate AS (
         SELECT sp.id, sp."productId", sp."nameOrig",
                0 AS rank, sp."inStock", sp."lastSeen"
         FROM store_product sp
         WHERE sp.id = $1
         UNION ALL
         SELECT sp.id, sp."productId", sp."nameOrig",
                1 AS rank, sp."inStock", sp."lastSeen"
         FROM store_product sp
         WHERE sp."productId" = $1
       )
       SELECT id, "productId", "nameOrig"
       FROM candidate
       ORDER BY rank, "inStock" DESC, "lastSeen" DESC
       LIMIT 1`,
      [id],
    ) as StoreProductRef[];

    return rows[0] ?? null;
  }

  /**
   * Lists the distinct countries referenced by at least one in-stock offer,
   * for the catalog filter chips. The country is the bottling's, availability
   * is the offer's, so the two have to be joined.
   *
   * @returns Countries present in the catalog, ordered by Ukrainian name.
   */
  public async distinctCountries(): Promise<MetaCountry[]> {
    return this.query(
      `SELECT c.code, c."nameUa", c.icon
       FROM country c
       WHERE EXISTS (
         SELECT 1 FROM store_product sp
         JOIN product p ON p.id = sp."productId"
         WHERE p."countryId" = c.id AND sp."inStock"
       )
       ORDER BY c."nameUa"`,
    ) as Promise<MetaCountry[]>;
  }

  /**
   * Counts the in-stock offers of a store.
   *
   * @param storeId - Store id.
   * @returns The in-stock offer count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    const rows = await this.query(
      `SELECT COUNT(*)::int AS count FROM store_product
       WHERE "storeId" = $1 AND "inStock"`,
      [storeId],
    ) as { count: number }[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Resolves an offer id from a search term: an id (of either kind), otherwise
   * the most recently seen offer whose canonical name, raw name or URL contains
   * the term. The raw name is matched too because the canonical one holds only
   * brand + expression, so descriptors a user may search for ("Welsh", "Single
   * Malt") survive only there. Out-of-stock offers still resolve (their history
   * stays reachable), but an in-stock match wins a collision.
   *
   * @param term - An offer id, a product id, or a name/URL substring.
   * @returns The matching offer id, or null when nothing matches.
   */
  public async resolveIdByTerm(term: string): Promise<ID | null> {
    if (/^[0-9a-f-]{36}$/i.test(term)) {
      const ref = await this.findOfferRefById(term);

      return ref?.id ?? null;
    }

    const rows = await this.query(
      `SELECT sp.id FROM store_product sp
       JOIN product p ON p.id = sp."productId"
       WHERE p.name ILIKE '%' || $1 || '%'
          OR sp."nameOrig" ILIKE '%' || $1 || '%'
          OR sp.url ILIKE '%' || $1 || '%'
       ORDER BY sp."inStock" DESC, sp."lastSeen" DESC
       LIMIT 1`,
      [term],
    ) as { id: ID }[];

    return rows[0]?.id ?? null;
  }
}
