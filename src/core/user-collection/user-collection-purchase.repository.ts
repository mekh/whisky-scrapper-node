import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { QueryDeepPartialEntity } from 'typeorm';

import { BaseRepository } from '~core/_common';
import { CollectionTimelineGranularity } from '~enums';
import { ServerError } from '~errors';
import {
  CollectionCountryBucket,
  CollectionPurchaseResolved,
  CollectionPurchaseRow,
  CollectionRegionBucket,
  CollectionStatsBounds,
  CollectionStatsPurchase,
  CollectionStoreBucket,
  CollectionSummaryRow,
  CollectionTimelineBucket,
  ID,
} from '~types';

import { UserCollectionPurchaseEntity } from './user-collection-purchase.entity';

/**
 * `QueryDeepPartialEntity` maps every property of the entity it is given,
 * and the entity types every nullable column as optional-but-never-`null`
 * (`storeId?: ID`, etc.) — the shape TypeORM derives from the class.
 * {@link CollectionPurchaseResolved} deliberately writes an explicit `null`
 * to *clear* such a column (an absent key means "leave alone"), so one cast
 * here is what lets that write compile without loosening the field types
 * every other consumer of the entity relies on.
 *
 * @param values - The columns to write, nulls included.
 * @returns The same object, typed as TypeORM's write shape.
 */
const asWriteValues = (
  values: CollectionPurchaseResolved & { collectionId?: ID },
): QueryDeepPartialEntity<UserCollectionPurchaseEntity> =>
  values as QueryDeepPartialEntity<UserCollectionPurchaseEntity>;

/**
 * Every purchase of a set of collection rows, store resolved to its display
 * columns. `purchasedOn` is cast to `text`: left as `date`, the raw driver
 * hands back a JS `Date`, while the API contract (and
 * {@link CollectionPurchaseRow.purchasedOn}) is a bare `YYYY-MM-DD` string.
 * `price` is cast to `float8` because `numeric` otherwise comes back as a
 * string — the same reason every other money column in this codebase casts.
 * The order (`purchasedOn`, then `createdAt`, then `id`) is what
 * {@link CollectionItem.purchases} renders: oldest purchase first, ties
 * broken by insertion order, and finally by id so paging is stable.
 */
const FIND_BY_COLLECTION_IDS_SQL = `
  SELECT ucp.id, ucp."collectionId",
         ucp."purchasedOn"::text AS "purchasedOn",
         ucp.price::float8 AS price,
         st.slug AS "storeSlug", st.name AS "storeLabel",
         st.color AS "storeColor",
         ucp."storeName", ucp."storeProductId", ucp."createdAt"
  FROM user_collection_purchase ucp
  LEFT JOIN store st ON st.id = ucp."storeId"
  WHERE ucp."collectionId" = ANY($1::uuid[])
  ORDER BY ucp."purchasedOn", ucp."createdAt", ucp.id
`;

/**
 * One row of KPIs over a user's *whole* collection. Starts `FROM
 * user_collection` and `LEFT JOIN`s the purchases — starting from the
 * purchases instead would silently drop a collection row nobody has bought
 * yet, which is a legitimate state (tasted at a bar, or a gift) and must
 * still count toward `items`. With no `GROUP BY`, the aggregates always
 * return exactly one row, zeros included, so the caller needs no fallback
 * for "the user has no collection at all".
 */
const SUMMARY_SQL = `
  SELECT COUNT(DISTINCT uc.id)::int AS items,
         COUNT(ucp.id)::int AS bottles,
         COUNT(ucp.id) FILTER (WHERE ucp.price IS NOT NULL)::int
           AS "pricedBottles",
         COALESCE(SUM(ucp.price), 0)::float8 AS "totalSpent",
         AVG(ucp.price)::float8 AS "avgPrice"
  FROM user_collection uc
  LEFT JOIN user_collection_purchase ucp ON ucp."collectionId" = uc.id
  WHERE uc."userId" = $1
`;

/**
 * The cheapest or dearest *priced* purchase of a user's collection, joined to
 * its bottling and to the store it names. `nameOrig` is resolved through the
 * same `LEFT JOIN LATERAL` tie-break (`inStock DESC, lastSeen DESC, id`)
 * `PreferenceRepository`'s details read uses, so the two screens agree on
 * which store's raw name stands for a bottling. Purchases with no price are
 * excluded outright — there is nothing to rank them by.
 *
 * The `ORDER BY`/`LIMIT` are appended by the caller: Postgres accepts no bind
 * parameter for a sort direction, and the literal is resolved through
 * {@link UserCollectionPurchaseRepository.sqlDirection} against a two-value
 * whitelist rather than ever being the raw argument.
 */
const EXTREME_PURCHASE_SQL = `
  SELECT ucp.id AS "purchaseId", ucp."collectionId", uc."productId",
         p.name, o."nameOrig", p.age, p.abv::float8 AS abv, p."volumeMl",
         ucp.price::float8 AS price,
         ucp."purchasedOn"::text AS "purchasedOn",
         st.slug AS "storeSlug", st.name AS "storeLabel",
         st.color AS "storeColor", ucp."storeName"
  FROM user_collection_purchase ucp
  JOIN user_collection uc ON uc.id = ucp."collectionId"
  JOIN product p ON p.id = uc."productId"
  LEFT JOIN store st ON st.id = ucp."storeId"
  LEFT JOIN LATERAL (
    SELECT sp."nameOrig"
    FROM store_product sp
    WHERE sp."productId" = p.id
    ORDER BY sp."inStock" DESC, sp."lastSeen" DESC, sp.id
    LIMIT 1
  ) o ON true
  WHERE uc."userId" = $1 AND ucp.price IS NOT NULL
`;

/**
 * Bottles and distinct whiskies of a user's collection, grouped by country.
 * `FROM user_collection` with a `LEFT JOIN` to the purchases keeps a
 * zero-purchase row contributing to `items` (the same reason
 * {@link SUMMARY_SQL} is shaped this way); `bottles` counts the joined
 * purchase rows, which a plain `COUNT(DISTINCT uc.id)` cannot tell apart from
 * one bottle bought many times. The `unknown` bucket is one real group, not a
 * label glued on after: `c.code`, `c."nameUa"` and `c.icon` all come from the
 * same (possibly unmatched) row, so grouping by the three of them — rather
 * than by the ordinal `COALESCE` expression — is what lets the name/icon
 * columns stay null for it without Postgres rejecting them as ungrouped.
 */
const COUNTRY_BUCKETS_SQL = `
  SELECT COALESCE(c.code, 'unknown') AS "countryCode",
         c."nameUa" AS "countryName",
         c.icon AS "countryIcon",
         COUNT(ucp.id)::int AS bottles,
         COUNT(DISTINCT uc.id)::int AS items
  FROM user_collection uc
  JOIN product p ON p.id = uc."productId"
  LEFT JOIN country c ON c.id = p."countryId"
  LEFT JOIN user_collection_purchase ucp ON ucp."collectionId" = uc.id
  WHERE uc."userId" = $1
  GROUP BY c.code, c."nameUa", c.icon
  ORDER BY bottles DESC, items DESC, "countryCode"
`;

/**
 * The same shape as {@link COUNTRY_BUCKETS_SQL}, restricted to Scotch
 * (`c.code = 'GB-SCT'`, the real code this database stores) and keyed by the
 * Scotland region of the resolved *distillery* — `producer pr ON pr.id =
 * p."producerId"`, deliberately not `bottlerId`: an independent bottling's
 * region is asked of the distillery that made the spirit, not the merchant
 * that bottled it.
 */
const REGION_BUCKETS_SQL = `
  SELECT COALESCE(pr.region, 'unknown') AS region,
         COUNT(ucp.id)::int AS bottles,
         COUNT(DISTINCT uc.id)::int AS items
  FROM user_collection uc
  JOIN product p ON p.id = uc."productId"
  JOIN country c ON c.id = p."countryId"
  LEFT JOIN producer pr ON pr.id = p."producerId"
  LEFT JOIN user_collection_purchase ucp ON ucp."collectionId" = uc.id
  WHERE uc."userId" = $1 AND c.code = 'GB-SCT'
  GROUP BY pr.region
  ORDER BY bottles DESC, items DESC, region
`;

/**
 * Bottles and spend grouped by shop. A purchase naming neither a known store
 * nor a free-text one (a gift with nowhere it was bought) is excluded — there
 * is no shop to attribute it to. Grouping by `(st.id, ucp."storeName")`
 * rather than by every displayed column relies on `st.id` being the `store`
 * table's own primary key: Postgres then treats `st.slug`/`st.name`/
 * `st.color` as functionally dependent on it and allows them ungrouped, which
 * is what lets a known store (grouped on its id, `storeName` always null
 * beside it) and a free-text shop (`st.id` null, grouped on the text) share
 * one query without a `UNION`.
 */
const STORE_BUCKETS_SQL = `
  SELECT st.slug,
         COALESCE(st.name, ucp."storeName") AS name,
         st.color,
         COUNT(*)::int AS bottles,
         COALESCE(SUM(ucp.price), 0)::float8 AS spent
  FROM user_collection_purchase ucp
  JOIN user_collection uc ON uc.id = ucp."collectionId"
  LEFT JOIN store st ON st.id = ucp."storeId"
  WHERE uc."userId" = $1
    AND (ucp."storeId" IS NOT NULL OR ucp."storeName" IS NOT NULL)
  GROUP BY st.id, ucp."storeName"
  ORDER BY bottles DESC, spent DESC, name
`;

/**
 * Per-granularity fragments for {@link UserCollectionPurchaseRepository
 * .timelineForUser}: the `date_trunc`/`generate_series` unit and the
 * `to_char` display format. Indexing this table by the enum *is* the
 * validation — interpolating `parts.trunc`/`parts.step`/`parts.format` can
 * therefore never put anything but one of these two literals into the query
 * text, however the caller obtained its `granularity` value.
 */
const TIMELINE_SQL_PARTS: Record<
  CollectionTimelineGranularity,
  { trunc: string; step: string; format: string }
> = {
  [CollectionTimelineGranularity.MONTH]: {
    trunc: 'month',
    step: '1 month',
    format: 'YYYY-MM',
  },
  [CollectionTimelineGranularity.YEAR]: {
    trunc: 'year',
    step: '1 year',
    format: 'YYYY',
  },
};

/**
 * The months a user's purchases span. `MIN`/`MAX` over an empty set are both
 * `NULL`, and `to_char(NULL, ...)` is `NULL` too, so a user with no purchases
 * gets back one row of two nulls rather than zero rows — the caller turns
 * that into a null result instead of a default range.
 */
const BOUNDS_SQL = `
  SELECT to_char(MIN(ucp."purchasedOn"), 'YYYY-MM') AS "firstMonth",
         to_char(MAX(ucp."purchasedOn"), 'YYYY-MM') AS "lastMonth"
  FROM user_collection_purchase ucp
  JOIN user_collection uc ON uc.id = ucp."collectionId"
  WHERE uc."userId" = $1
`;

/**
 * Owns the `user_collection_purchase` table: every individual bottle-buying
 * event, plus the aggregate reads behind the statistics screen. Every stats
 * method is scoped to one user by joining `user_collection` and filtering on
 * its `userId` — a purchase carries no `userId` of its own.
 */
@TypeormRepository(UserCollectionPurchaseEntity)
export class UserCollectionPurchaseRepository
  extends BaseRepository<UserCollectionPurchaseEntity> {
  /**
   * Resolves a purchase-price sort direction to its literal SQL keyword.
   *
   * Postgres accepts no bind parameter in `ORDER BY`'s direction position, so
   * the value must be interpolated into the query text. Mapping it through
   * this two-way whitelist — rather than interpolating `order` itself — is
   * what keeps anything but `ASC`/`DESC` from ever reaching the query.
   *
   * @param order - The requested direction.
   * @returns The literal `ASC` or `DESC` keyword.
   */
  private static sqlDirection(order: 'ASC' | 'DESC'): string {
    return order === 'ASC' ? 'ASC' : 'DESC';
  }

  /**
   * Loads every purchase of the given collection rows, oldest first.
   *
   * @param collectionIds - Collection rows to load purchases for.
   * @returns One row per purchase; empty when `collectionIds` is empty or
   *   none of them have purchases.
   */
  public async findByCollectionIds(
    collectionIds: ID[],
  ): Promise<CollectionPurchaseRow[]> {
    if (!collectionIds.length) {
      return [];
    }

    return this.query(
      FIND_BY_COLLECTION_IDS_SQL,
      [collectionIds],
    ) as Promise<CollectionPurchaseRow[]>;
  }

  /**
   * Records one purchase against a collection row.
   *
   * @param collectionId - The collection row the purchase belongs to.
   * @param values - The purchase's resolved columns.
   * @returns The new purchase's id.
   * @throws {ServerError} When the driver reports no generated id.
   */
  public async insertForCollection(
    collectionId: ID,
    values: CollectionPurchaseResolved,
  ): Promise<ID> {
    const result = await this.insert(
      asWriteValues({ collectionId, ...values }),
    );

    const id = result.identifiers[0]?.id as ID | undefined;

    if (!id) {
      throw new ServerError('Failed to insert collection purchase');
    }

    return id;
  }

  /**
   * Patches one purchase, scoped to the collection row it must belong to.
   *
   * @param id - The purchase to update.
   * @param collectionId - Its owning collection row; a mismatch matches no
   *   row, so a foreign purchase can never be edited through this call.
   * @param values - The columns to change; an explicit `null` clears one.
   * @returns True when a row was updated. An empty `values` object is a
   *   no-op that returns true without issuing a statement — TypeORM rejects
   *   an `UPDATE` with no columns to set.
   */
  public async updateForCollection(
    id: ID,
    collectionId: ID,
    values: CollectionPurchaseResolved,
  ): Promise<boolean> {
    if (!Object.keys(values).length) {
      return true;
    }

    const result = await this.update(
      { id, collectionId },
      asWriteValues(values),
    );

    return !!result.affected;
  }

  /**
   * Deletes one purchase, scoped to the collection row it must belong to.
   *
   * @param id - The purchase to delete.
   * @param collectionId - Its owning collection row; a mismatch matches no
   *   row.
   * @returns True when a row was deleted.
   */
  public async deleteForCollection(id: ID, collectionId: ID): Promise<boolean> {
    const result = await this.delete({ id, collectionId });

    return !!result.affected;
  }

  /**
   * Counts the purchases recorded against one collection row.
   *
   * @param collectionId - The collection row to count.
   * @returns The number of purchases it holds.
   */
  public async countByCollection(collectionId: ID): Promise<number> {
    return this.countBy({ collectionId });
  }

  /**
   * The KPIs behind the statistics screen's summary tiles.
   *
   * @param userId - Whose collection to summarize.
   * @returns The summary row; zeros and a null `avgPrice` for an empty
   *   collection.
   */
  public async summaryForUser(userId: ID): Promise<CollectionSummaryRow> {
    const rows = await this.query(
      SUMMARY_SQL,
      [userId],
    ) as CollectionSummaryRow[];

    return rows[0] ?? {
      items: 0,
      bottles: 0,
      pricedBottles: 0,
      totalSpent: 0,
      avgPrice: null,
    };
  }

  /**
   * The cheapest or dearest priced purchase in a user's collection.
   *
   * @param userId - Whose collection to search.
   * @param order - `ASC` for the cheapest, `DESC` for the dearest.
   * @returns The extreme purchase, or null when nothing carries a price.
   */
  public async extremePurchaseForUser(
    userId: ID,
    order: 'ASC' | 'DESC',
  ): Promise<CollectionStatsPurchase | null> {
    const direction = UserCollectionPurchaseRepository.sqlDirection(order);

    const rows = await this.query(
      `${EXTREME_PURCHASE_SQL}
       ORDER BY ucp.price ${direction}, ucp."purchasedOn", ucp.id
       LIMIT 1`,
      [userId],
    ) as {
      purchaseId: ID;
      collectionId: ID;
      productId: ID;
      name: string | null;
      nameOrig: string | null;
      age: number | null;
      abv: number | null;
      volumeMl: number | null;
      price: number;
      purchasedOn: string;
      storeSlug: string | null;
      storeLabel: string | null;
      storeColor: string | null;
      storeName: string | null;
    }[];

    const row = rows[0];

    if (!row) {
      return null;
    }

    return {
      purchaseId: row.purchaseId,
      collectionId: row.collectionId,
      productId: row.productId,
      name: row.name,
      nameOrig: row.nameOrig,
      age: row.age,
      abv: row.abv,
      volumeMl: row.volumeMl,
      price: row.price,
      purchasedOn: row.purchasedOn,
      store: row.storeSlug && row.storeLabel
        ? { slug: row.storeSlug, name: row.storeLabel, color: row.storeColor }
        : null,
      storeName: row.storeName,
    };
  }

  /**
   * Bottles and distinct whiskies of a user's collection, grouped by country
   * of origin.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per country, largest bottle count first; a bottling
   *   whose country never resolved falls under `unknown`.
   */
  public async countByCountryForUser(
    userId: ID,
  ): Promise<CollectionCountryBucket[]> {
    return this.query(
      COUNTRY_BUCKETS_SQL,
      [userId],
    ) as Promise<CollectionCountryBucket[]>;
  }

  /**
   * Bottles and distinct whiskies of a user's collection, grouped by
   * Scotland region. Scotch only — a bottling whose country is not Scotland
   * is absent entirely, not folded into `unknown`.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per region, largest bottle count first; a Scotch
   *   whose distillery never resolved falls under `unknown`.
   */
  public async countByRegionForUser(
    userId: ID,
  ): Promise<CollectionRegionBucket[]> {
    return this.query(
      REGION_BUCKETS_SQL,
      [userId],
    ) as Promise<CollectionRegionBucket[]>;
  }

  /**
   * Bottles and spend of a user's collection, grouped by shop.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per known store plus one per distinct free-text
   *   shop name, largest bottle count first.
   */
  public async countByStoreForUser(
    userId: ID,
  ): Promise<CollectionStoreBucket[]> {
    return this.query(
      STORE_BUCKETS_SQL,
      [userId],
    ) as Promise<CollectionStoreBucket[]>;
  }

  /**
   * The "bottles added over time" series, dense over the requested range: a
   * period with no purchases still comes back, with zeros.
   *
   * @param userId - Whose purchases to bucket.
   * @param from - First month of the range (`YYYY-MM`), bound as a
   *   parameter — never interpolated.
   * @param to - Last month of the range (`YYYY-MM`), bound the same way.
   * @param granularity - Bucket width. Only this value is interpolated, and
   *   only after being resolved through {@link TIMELINE_SQL_PARTS}, keyed by
   *   the enum itself.
   * @returns One bucket per period in `[from, to]`, ascending.
   */
  public async timelineForUser(
    userId: ID,
    from: string,
    to: string,
    granularity: CollectionTimelineGranularity,
  ): Promise<CollectionTimelineBucket[]> {
    const parts = TIMELINE_SQL_PARTS[granularity];

    return this.query(
      `WITH bounds AS (
         SELECT date_trunc('${parts.trunc}', ($2 || '-01')::date) AS d0,
                date_trunc('${parts.trunc}', ($3 || '-01')::date) AS d1
       ),
       periods AS (
         SELECT generate_series(b.d0, b.d1, '${parts.step}'::interval)
                  AS period
         FROM bounds b
       ),
       purchases AS (
         SELECT date_trunc('${parts.trunc}', ucp."purchasedOn") AS period,
                COUNT(*)::int AS bottles,
                COALESCE(SUM(ucp.price), 0)::float8 AS spent
         FROM user_collection_purchase ucp
         JOIN user_collection uc ON uc.id = ucp."collectionId"
         CROSS JOIN bounds b
         WHERE uc."userId" = $1
           AND ucp."purchasedOn" >= b.d0
           AND ucp."purchasedOn" < b.d1 + '${parts.step}'::interval
         GROUP BY 1
       )
       SELECT to_char(p.period, '${parts.format}') AS period,
              COALESCE(pu.bottles, 0)::int AS bottles,
              COALESCE(pu.spent, 0)::float8 AS spent
       FROM periods p
       LEFT JOIN purchases pu ON pu.period = p.period
       ORDER BY p.period`,
      [userId, from, to],
    ) as Promise<CollectionTimelineBucket[]>;
  }

  /**
   * The months a user's purchases span.
   *
   * @param userId - Whose purchases to bound.
   * @returns The first and last purchase month, or null when the user has
   *   recorded no purchases at all.
   */
  public async boundsForUser(
    userId: ID,
  ): Promise<CollectionStatsBounds | null> {
    const rows = await this.query(BOUNDS_SQL, [userId]) as {
      firstMonth: string | null;
      lastMonth: string | null;
    }[];

    const row = rows[0];

    if (!row?.firstMonth || !row.lastMonth) {
      return null;
    }

    return { firstMonth: row.firstMonth, lastMonth: row.lastMonth };
  }
}
