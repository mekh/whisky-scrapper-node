import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import {
  ID,
  MetaCountry,
  PriceHistoryPoint,
  ReportCurrentRow,
  ReportFilter,
} from '~types';

import { ProductEntity } from './product.entity';

// Latest snapshot per product (+ the immediately previous price) joined to the
// lookup tables. `rn = 1` keeps only the newest snapshot; `LEAD` reaches the
// one before it. Numeric columns are cast to float8 and dates to text so the
// raw driver returns JS numbers/`YYYY-MM-DD` strings rather than strings/Dates.
const CURRENT_SQL = `
  WITH ranked AS (
    SELECT s."productId",
           s.price, s."oldPrice", s.currency, s."inStock", s.promo,
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
         r.currency, r."inStock", r.promo,
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
   * Loads the current state (latest snapshot + previous price + joins) of
   * every product matching the filter. Filtering runs in SQL; report-specific
   * logic and pagination are applied by the caller.
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
      AND ($1::text[] IS NULL OR st.slug = ANY($1))
      AND ($2::float8 IS NULL OR r.price >= $2)
      AND ($3::float8 IS NULL OR r.price <= $3)
      AND ($4::int IS NULL OR p."volumeMl" >= $4)
      AND ($5::int IS NULL OR p."volumeMl" <= $5)
      AND ($6::text[] IS NULL OR lower(c.code) = ANY($6))
      AND ($7::text IS NULL OR p.name ILIKE '%' || $7 || '%')
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
   * Loads the current row for a single product by id.
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
   * Lists the distinct countries referenced by at least one product, for the
   * catalog filter chips.
   *
   * @returns Countries present in the catalog, ordered by Ukrainian name.
   */
  public async distinctCountries(): Promise<MetaCountry[]> {
    return this.query(
      `SELECT c.code, c."nameUa", c.icon
       FROM country c
       WHERE EXISTS (SELECT 1 FROM product p WHERE p."countryId" = c.id)
       ORDER BY c."nameUa"`,
    ) as Promise<MetaCountry[]>;
  }

  /**
   * Counts the products currently tracked for a store.
   *
   * @param storeId - Store id.
   * @returns The product count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    const rows = await this.query(
      'SELECT COUNT(*)::int AS count FROM product WHERE "storeId" = $1',
      [storeId],
    ) as { count: number }[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Resolves a product id from a search term: an exact id, otherwise the
   * most recently seen product whose name or URL contains the term.
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
         WHERE name ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%'
         ORDER BY "lastSeen" DESC
         LIMIT 1`,
        [term],
      ) as { id: ID }[];

    return rows[0]?.id ?? null;
  }
}
