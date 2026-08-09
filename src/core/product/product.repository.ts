import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  ID,
  MetaCountry,
  PriceHistoryPoint,
  ProductUpsertInput,
  ProductUpsertResult,
  ReportCurrentRow,
  ReportFilter,
} from '~types';

import { ProductEntity } from './product.entity';

// Latest snapshot per product (+ the immediately previous price) joined to the
// lookup tables. `rn = 1` keeps only the newest snapshot; `LEAD` reaches the
// one before it. The row's `inStock` comes from the product (its current
// availability), not from the snapshot. Numeric columns are cast to float8 and
// dates to text so the raw driver returns JS numbers/`YYYY-MM-DD` strings
// rather than strings/Dates.
const CURRENT_SQL = `
  WITH ranked AS (
    SELECT s."productId",
           s.price, s."oldPrice", s.currency, s.promo,
           s."createdAt"::date AS captured,
           ROW_NUMBER() OVER w AS rn,
           LEAD(s.price) OVER w AS prev
    FROM price_snapshot s
    WINDOW w AS (PARTITION BY s."productId" ORDER BY s."createdAt" DESC)
  )
  SELECT p.id, p.sku, p.url, p.name, p."nameOrig", p.age, p.abv, p."volumeMl",
         p."firstSeen"::text AS "firstSeen",
         st.slug AS "storeSlug", st.name AS "storeName",
         b.name AS brand, t.name AS type,
         c.code AS "countryCode", c."nameUa" AS "countryName",
         c.icon AS "countryIcon",
         r.price::float8 AS price,
         r."oldPrice"::float8 AS "oldPrice",
         r.currency, p."inStock", r.promo,
         r.prev::float8 AS "previousPrice",
         r.captured::text AS "capturedDate",
         COALESCE((
           SELECT array_agg(f.name ORDER BY f.name)
           FROM product_flavor pf
           JOIN flavor f ON f.id = pf."flavorId"
           WHERE pf."productId" = p.id
         ), '{}') AS flavors
  FROM ranked r
  JOIN product p ON p.id = r."productId"
  JOIN store st ON st.id = p."storeId"
  LEFT JOIN brand b ON b.id = p."brandId"
  LEFT JOIN type t ON t.id = p."typeId"
  LEFT JOIN country c ON c.id = p."countryId"
  WHERE r.rn = 1
`;

@TypeormRepository(ProductEntity)
export class ProductRepository extends BaseRepository<ProductEntity> {
  /**
   * Inserts or updates a product by its `(storeId, sku)` identity. On conflict
   * only `url`, `nameOrig`, `lastSeen`, `brandId` and `inStock` change —
   * `brandId` via COALESCE so a later null never clears a known brand, and
   * `inStock` back to true since only in-stock items are upserted — while
   * `name`, the type/country/age/abv/volume fields and `firstSeen` are written
   * once on insert and then left untouched, so manual edits survive later
   * scrapes.
   *
   * @param input - The resolved product to write.
   * @returns The product id and whether it was newly inserted.
   */
  public async upsertFromScrape(
    input: ProductUpsertInput,
  ): Promise<ProductUpsertResult> {
    const rows = await this.query(
      `INSERT INTO product
         ("storeId", "brandId", "typeId", "countryId", age, abv, "volumeMl",
          sku, url, name, "nameOrig", "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT ("storeId", sku) DO UPDATE SET
         url = EXCLUDED.url,
         "nameOrig" = EXCLUDED."nameOrig",
         "brandId" = COALESCE(EXCLUDED."brandId", product."brandId"),
         "inStock" = true,
         "lastSeen" = EXCLUDED."lastSeen",
         "updatedAt" = now()
       RETURNING id, (xmax = 0) AS "isNew"`,
      [
        input.storeId,
        input.brandId,
        input.typeId,
        input.countryId,
        input.age,
        input.abv,
        input.volumeMl,
        input.sku,
        input.url,
        input.name,
        input.nameOrig,
        input.seenOn,
      ],
    ) as { id: ID; isNew: boolean }[];

    return { id: rows[0].id, isNew: rows[0].isNew };
  }

  /**
   * SKUs of a store's products whose ABV is already filled. The collector uses
   * this to fetch product detail pages only for new or still-incomplete items.
   *
   * @param storeId - Store id.
   * @returns The set of SKUs that already have an ABV.
   */
  public async skusWithAbv(storeId: ID): Promise<Set<string>> {
    const rows = await this.query(
      'SELECT sku FROM product WHERE "storeId" = $1 AND abv IS NOT NULL',
      [storeId],
    ) as { sku: string }[];

    return new Set(rows.map((row) => row.sku));
  }

  /**
   * SKUs of a store's products that already exist, whatever their stock state.
   * The name-extraction pass uses this to skip known SKUs: `name` is written
   * once on insert and never on conflict, so extracting it again would be a
   * wasted LLM call that could never be persisted.
   *
   * @param storeId - Store id.
   * @returns The set of SKUs already stored for the store.
   */
  public async existingSkus(storeId: ID): Promise<Set<string>> {
    const rows = await this.query(
      'SELECT sku FROM product WHERE "storeId" = $1',
      [storeId],
    ) as { sku: string }[];

    return new Set(rows.map((row) => row.sku));
  }

  /**
   * Flags a store's products as out of stock by SKU (the items the latest
   * listing explicitly returned as unavailable). The rows and their price
   * history are kept. Flags nothing when the list is empty.
   *
   * @param storeId - Store id.
   * @param skus - SKUs to flag.
   * @returns How many products were flagged.
   */
  public async markOutOfStockBySkus(
    storeId: ID,
    skus: string[],
  ): Promise<number> {
    if (!skus.length) {
      return 0;
    }

    const result = await this.createQueryBuilder()
      .update(ProductEntity)
      .set({ inStock: false })
      .where('"storeId" = :storeId', { storeId })
      .andWhere('"inStock"')
      .andWhere('sku = ANY(:skus)', { skus })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Flags every in-stock product of a store as out of stock except the given
   * SKUs (the sweep after a full listing: whatever the run did not see in
   * stock is no longer available). The rows and their price history are kept.
   *
   * @param storeId - Store id.
   * @param keepSkus - SKUs seen in stock this run, to leave untouched.
   * @returns How many products were flagged.
   */
  public async markOutOfStockExcept(
    storeId: ID,
    keepSkus: string[],
  ): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(ProductEntity)
      .set({ inStock: false })
      .where('"storeId" = :storeId', { storeId })
      .andWhere('"inStock"')
      .andWhere('NOT (sku = ANY(:keepSkus))', { keepSkus })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Clears the age of the given products. Used by the age audit to drop values
   * no source ever stated — `age` is insert-only, so a wrong value written
   * once is never corrected by a later scrape.
   *
   * @param ids - Products whose age to clear.
   * @returns How many rows changed.
   */
  public async clearAges(ids: ID[]): Promise<number> {
    if (!ids.length) {
      return 0;
    }

    const result = await this.createQueryBuilder()
      .update(ProductEntity)
      .set({ age: () => 'NULL' })
      .where('id = ANY(:ids)', { ids })
      .andWhere('age IS NOT NULL')
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Replaces a product's flavor links with the given set (deduplicated).
   *
   * @param productId - Product id.
   * @param flavorIds - Flavor ids to link; duplicates are ignored.
   * @returns Resolves once the links are replaced.
   */
  public async setFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    await this.query(
      'DELETE FROM product_flavor WHERE "productId" = $1',
      [productId],
    );

    const distinct = [...new Set(flavorIds)];

    if (!distinct.length) {
      return;
    }

    const values = distinct
      .map((_, index) => `($1, $${index + 2})`)
      .join(', ');

    await this.query(
      `INSERT INTO product_flavor ("productId", "flavorId") VALUES ${values} `
        + 'ON CONFLICT DO NOTHING',
      [productId, ...distinct],
    );
  }

  /**
   * Loads the current state (latest snapshot + previous price + joins) of
   * every in-stock product matching the filter — out-of-stock products are
   * always excluded here. Filtering runs in SQL; report-specific logic and
   * pagination are applied by the caller.
   *
   * @param filter - The report filter; empty fields mean no constraint.
   * @returns One row per matching product.
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
      AND p."inStock"
      AND ($1::text[] IS NULL OR st.slug = ANY($1))
      AND ($2::float8 IS NULL OR r.price >= $2)
      AND ($3::float8 IS NULL OR r.price <= $3)
      AND ($4::int IS NULL OR p."volumeMl" >= $4)
      AND ($5::int IS NULL OR p."volumeMl" <= $5)
      AND ($6::text[] IS NULL OR lower(c.code) = ANY($6))
      AND ($7::text IS NULL OR p.name ILIKE '%' || $7 || '%'
           OR p."nameOrig" ILIKE '%' || $7 || '%')
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
   * Loads the current row for a single product by id. Unlike the list query,
   * out-of-stock products are returned too (with `inStock: false`) so their
   * price history stays reachable.
   *
   * @param id - Product id.
   * @returns The product's current row, or null when it has no snapshot.
   */
  public async findCurrentRowById(id: ID): Promise<ReportCurrentRow | null> {
    const rows = await this.query(
      `${CURRENT_SQL} AND p.id = $1`,
      [id],
    ) as ReportCurrentRow[];

    return rows[0] ?? null;
  }

  /**
   * Returns the most recent snapshot capture date across all products.
   *
   * @returns The latest date (`YYYY-MM-DD`), or null when there are none.
   */
  public async latestDate(): Promise<string | null> {
    const rows = await this.query(
      'SELECT MAX("createdAt"::date)::text AS d FROM price_snapshot',
    ) as { d: string | null }[];

    return rows[0]?.d ?? null;
  }

  /**
   * Computes the min and max price per product over snapshots on/after a
   * cutoff date.
   *
   * @param cutoff - Inclusive lower bound date (`YYYY-MM-DD`).
   * @returns Map from product id to its `{ min, max }` price over the window.
   */
  public async priceExtremes(
    cutoff: string,
  ): Promise<Map<ID, { min: number; max: number }>> {
    const rows = await this.query(
      `SELECT "productId",
              MIN(price)::float8 AS min, MAX(price)::float8 AS max
       FROM price_snapshot
       WHERE "createdAt"::date >= $1
       GROUP BY "productId"`,
      [cutoff],
    ) as { productId: ID; min: number; max: number }[];

    return new Map(rows.map((row) => [row.productId, {
      min: row.min,
      max: row.max,
    }]));
  }

  /**
   * For every product, the date since which its price has not been higher than
   * its current (latest) price — i.e. when the current price level took hold.
   * It is the capture date of the first snapshot after the most recent one
   * priced above the current price; when the price was never higher, the
   * product's very first snapshot. Ages the `drops` report's current discount.
   *
   * @returns Map from product id to that date (`YYYY-MM-DD`).
   */
  public async currentPriceSince(): Promise<Map<ID, string>> {
    const rows = await this.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("productId")
                "productId", price AS "currentPrice"
         FROM price_snapshot
         ORDER BY "productId", "createdAt" DESC
       ),
       last_higher AS (
         SELECT s."productId", MAX(s."createdAt") AS "higherAt"
         FROM price_snapshot s
         JOIN latest l ON l."productId" = s."productId"
         WHERE s.price > l."currentPrice"
         GROUP BY s."productId"
       )
       SELECT s."productId", MIN(s."createdAt")::date::text AS since
       FROM price_snapshot s
       LEFT JOIN last_higher h ON h."productId" = s."productId"
       WHERE h."higherAt" IS NULL OR s."createdAt" > h."higherAt"
       GROUP BY s."productId"`,
    ) as { productId: ID; since: string }[];

    return new Map(rows.map((row) => [row.productId, row.since]));
  }

  /**
   * Loads a product's price history, oldest point first.
   *
   * @param id - Product id.
   * @param limit - Maximum number of most-recent points to return.
   * @returns Chronological price points.
   */
  public async priceSeries(
    id: ID,
    limit: number,
  ): Promise<PriceHistoryPoint[]> {
    const rows = await this.query(
      `SELECT "createdAt"::date::text AS date, price::float8 AS price
       FROM price_snapshot
       WHERE "productId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [id, limit],
    ) as PriceHistoryPoint[];

    return rows.reverse();
  }

  /**
   * Lists the distinct countries referenced by at least one in-stock product,
   * for the catalog filter chips.
   *
   * @returns Countries present in the catalog, ordered by Ukrainian name.
   */
  public async distinctCountries(): Promise<MetaCountry[]> {
    return this.query(
      `SELECT c.code, c."nameUa", c.icon
       FROM country c
       WHERE EXISTS (
         SELECT 1 FROM product p
         WHERE p."countryId" = c.id AND p."inStock"
       )
       ORDER BY c."nameUa"`,
    ) as Promise<MetaCountry[]>;
  }

  /**
   * Counts the in-stock products of a store.
   *
   * @param storeId - Store id.
   * @returns The in-stock product count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    const rows = await this.query(
      `SELECT COUNT(*)::int AS count FROM product
       WHERE "storeId" = $1 AND "inStock"`,
      [storeId],
    ) as { count: number }[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Resolves a product id from a search term: an exact id, otherwise the
   * most recently seen product whose cleaned name, raw name or URL contains
   * the term. The raw name is matched too because the cleaned one holds only
   * the brand + expression, so descriptors a user may search for ("Welsh",
   * "Single Malt") survive only in `nameOrig`. Out-of-stock products still
   * resolve (their history stays reachable), but an in-stock match wins a
   * name collision.
   *
   * @param term - A product id or a name/URL substring.
   * @returns The matching product id, or null when nothing matches.
   */
  public async resolveIdByTerm(term: string): Promise<ID | null> {
    const isUuid = /^[0-9a-f-]{36}$/i.test(term);

    const rows = isUuid
      ? await this.query(
        'SELECT id FROM product WHERE id = $1',
        [term],
      ) as { id: ID }[]
      : await this.query(
        `SELECT id FROM product
         WHERE name ILIKE '%' || $1 || '%'
            OR "nameOrig" ILIKE '%' || $1 || '%'
            OR url ILIKE '%' || $1 || '%'
         ORDER BY "inStock" DESC, "lastSeen" DESC
         LIMIT 1`,
        [term],
      ) as { id: ID }[];

    return rows[0]?.id ?? null;
  }
}
