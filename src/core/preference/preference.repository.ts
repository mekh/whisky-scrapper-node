import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { Repository } from 'typeorm';

import {
  ID,
  Preference,
  PreferenceBrand,
  PreferenceDetails,
  PreferenceProductRow,
} from '~types';

import { FavoriteEntity } from './favorite.entity';

/**
 * Reads all three preference lists in one round trip. `array_agg` over an empty
 * set is null, hence the `COALESCE` to an empty array — the same shape
 * `CURRENT_SQL` uses for a product's flavors. Brands come back as names because
 * that is the only form the API speaks; ids never leave this layer.
 */
const FIND_SQL = `
  SELECT
    COALESCE((
      SELECT array_agg(f."productId" ORDER BY f."createdAt", f."productId")
      FROM favorite f WHERE f."userId" = $1
    ), '{}') AS favorites,
    COALESCE((
      SELECT array_agg(bp."productId" ORDER BY bp."createdAt", bp."productId")
      FROM blacklist_product bp WHERE bp."userId" = $1
    ), '{}') AS "blacklistProducts",
    COALESCE((
      SELECT array_agg(pr.name ORDER BY pr.name)
      FROM blacklist_producer bp2
      JOIN producer pr ON pr.id = bp2."producerId"
      WHERE bp2."userId" = $1
    ), '{}') AS "blacklistBrands"
`;

/**
 * Resolves both product lists in one pass, each row joined to what the
 * settings screen renders. Joining `product`, `producer` and `store_product`
 * here follows `FIND_SQL`, which already joins `producer` — the layering rule
 * bars a foreign *service* from injecting this repository, not a join.
 *
 * Decisions that are easy to undo by accident:
 *
 * - `LEFT JOIN LATERAL`, not `JOIN`: an inner join would silently drop a
 *   bottling with no offer row — precisely the entry the user opened this
 *   screen to remove. Hence `nameOrig` is nullable and `inStock` coalesced.
 * - The lateral's tie-break (`inStock DESC, lastSeen DESC, id`) is the one
 *   `findOfferRefById` uses, so this screen and the product screen agree on
 *   which store's raw name stands for a bottling. It also makes the picked
 *   row's `inStock` mean "some offer is in stock" with no separate `EXISTS`.
 * - `abv::float8` — the column is `real`, which the raw driver would hand
 *   back as a string.
 * - `createdAt DESC`, unlike `FIND_SQL`'s ASC: the id payload feeds a `Set`
 *   where order is meaningless, while a management screen wants newest first.
 *   `addedOn` exposes only the UTC calendar day (the `capturedOn` precedent),
 *   but the ordering keys on the full timestamp, so same-day entries keep
 *   their true order.
 */
const DETAILS_PRODUCTS_SQL = `
  WITH item AS (
    SELECT 'favorite'::text AS list, f."productId", f."createdAt"
    FROM favorite f WHERE f."userId" = $1
    UNION ALL
    SELECT 'blacklist', bp."productId", bp."createdAt"
    FROM blacklist_product bp WHERE bp."userId" = $1
  )
  SELECT i.list, i."productId", p.name, o."nameOrig",
         COALESCE(pr.name, bo.name) AS brand, p.age,
         p.abv::float8 AS abv, p."volumeMl",
         COALESCE(o."inStock", false) AS "inStock",
         i."createdAt"::date::text AS "addedOn"
  FROM item i
  JOIN product p ON p.id = i."productId"
  LEFT JOIN producer pr ON pr.id = p."producerId"
  LEFT JOIN producer bo ON bo.id = p."bottlerId"
  LEFT JOIN LATERAL (
    SELECT sp."nameOrig", sp."inStock"
    FROM store_product sp
    WHERE sp."productId" = p.id
    ORDER BY sp."inStock" DESC, sp."lastSeen" DESC, sp.id
    LIMIT 1
  ) o ON true
  ORDER BY i."createdAt" DESC, i."productId"
`;

/**
 * Blacklisted brands with the day each rule was added, newest first.
 */
const DETAILS_BRANDS_SQL = `
  SELECT pr.name, bp2."createdAt"::date::text AS "addedOn"
  FROM blacklist_producer bp2
  JOIN producer pr ON pr.id = bp2."producerId"
  WHERE bp2."userId" = $1
  ORDER BY bp2."createdAt" DESC, pr.name
`;

/**
 * Owns all three preference tables. They are one feature, always read together
 * and written in the same transaction, so a single repository is the coherent
 * unit here — the same reason `ProductRepository` owns every `product_flavor`
 * row.
 *
 * Extends TypeORM's `Repository` rather than `BaseRepository`: these rows are
 * composite-keyed and carry no `id`, so they do not satisfy `EntityBase`, and
 * every method below is raw SQL that needs none of `BaseRepository`'s helpers.
 */
@TypeormRepository(FavoriteEntity)
export class PreferenceRepository extends Repository<FavoriteEntity> {
  /**
   * Loads a user's complete preference set.
   *
   * @param userId - Whose preferences to read.
   * @returns The three lists; each is empty when the user has no entries.
   */
  public async findByUserId(userId: ID): Promise<Preference> {
    const rows = await this.query(FIND_SQL, [userId]) as Preference[];

    return rows[0] ?? {
      favorites: [],
      blacklistProducts: [],
      blacklistBrands: [],
    };
  }

  /**
   * Loads a user's preference lists resolved to renderable entries, newest
   * first — what the settings screen shows, as opposed to the bare id sets
   * `findByUserId` answers with.
   *
   * The two statements run sequentially on purpose: under `@Transactional()`
   * both ride one CLS-bound connection, which cannot serve parallel queries.
   *
   * @param userId - Whose preferences to resolve.
   * @returns The three lists; each is empty when the user has no entries.
   */
  public async findDetailsByUserId(userId: ID): Promise<PreferenceDetails> {
    const products = await this.query(
      DETAILS_PRODUCTS_SQL,
      [userId],
    ) as PreferenceProductRow[];

    const brands = await this.query(
      DETAILS_BRANDS_SQL,
      [userId],
    ) as PreferenceBrand[];

    return {
      favorites: products
        .filter((row) => row.list === 'favorite')
        .map(({ list: _list, ...item }) => item),
      blacklistProducts: products
        .filter((row) => row.list === 'blacklist')
        .map(({ list: _list, ...item }) => item),
      blacklistBrands: brands,
    };
  }

  /**
   * Adds favorites, ignoring the ones already there.
   *
   * @param userId - Whose favorites to extend.
   * @param productIds - Canonical product ids. Must be deduplicated and sorted
   *   by the caller so concurrent transactions of the same user take their row
   *   locks in one agreed order.
   */
  public async addFavorites(userId: ID, productIds: ID[]): Promise<void> {
    await this.insertMembership('favorite', 'productId', userId, productIds);
  }

  /**
   * Removes favorites; ids that were never favorited are ignored.
   *
   * @param userId - Whose favorites to trim.
   * @param productIds - Canonical product ids to drop.
   */
  public async removeFavorites(userId: ID, productIds: ID[]): Promise<void> {
    await this.deleteMembership('favorite', 'productId', userId, productIds);
  }

  /**
   * Hides bottlings from every report, ignoring the ones already hidden.
   *
   * @param userId - Whose blacklist to extend.
   * @param productIds - Canonical product ids, deduplicated and sorted.
   */
  public async addBlacklistProducts(
    userId: ID,
    productIds: ID[],
  ): Promise<void> {
    await this.insertMembership(
      'blacklist_product',
      'productId',
      userId,
      productIds,
    );
  }

  /**
   * Un-hides bottlings; ids that were not hidden are ignored.
   *
   * @param userId - Whose blacklist to trim.
   * @param productIds - Canonical product ids to drop.
   */
  public async removeBlacklistProducts(
    userId: ID,
    productIds: ID[],
  ): Promise<void> {
    await this.deleteMembership(
      'blacklist_product',
      'productId',
      userId,
      productIds,
    );
  }

  /**
   * Hides brands from every report, ignoring the ones already hidden.
   *
   * @param userId - Whose blacklist to extend.
   * @param producerIds - Producer ids, deduplicated and sorted.
   */
  public async addBlacklistBrands(
    userId: ID,
    producerIds: ID[],
  ): Promise<void> {
    await this.insertMembership(
      'blacklist_producer',
      'producerId',
      userId,
      producerIds,
    );
  }

  /**
   * Un-hides brands; ids that were not hidden are ignored.
   *
   * @param userId - Whose blacklist to trim.
   * @param producerIds - Producer ids to drop.
   */
  public async removeBlacklistBrands(
    userId: ID,
    producerIds: ID[],
  ): Promise<void> {
    await this.deleteMembership(
      'blacklist_producer',
      'producerId',
      userId,
      producerIds,
    );
  }

  /**
   * Inserts membership rows for one user, leaving existing ones untouched.
   *
   * The table and column names are interpolated rather than bound because
   * Postgres allows no parameter in either position; both come from this
   * class's own call sites and never from a request.
   *
   * @param table - Target table.
   * @param column - The target column beside `userId`.
   * @param userId - The owning user.
   * @param ids - Values to insert; an empty array skips the statement.
   */
  private async insertMembership(
    table: string,
    column: string,
    userId: ID,
    ids: ID[],
  ): Promise<void> {
    if (!ids.length) {
      return;
    }

    await this.query(
      `INSERT INTO ${table} ("userId", "${column}")
       SELECT $1, value FROM unnest($2::uuid[]) AS t(value)
       ON CONFLICT ("userId", "${column}") DO NOTHING`,
      [userId, ids],
    );
  }

  /**
   * Deletes membership rows for one user.
   *
   * @param table - Target table.
   * @param column - The target column beside `userId`.
   * @param userId - The owning user.
   * @param ids - Values to delete; an empty array skips the statement.
   */
  private async deleteMembership(
    table: string,
    column: string,
    userId: ID,
    ids: ID[],
  ): Promise<void> {
    if (!ids.length) {
      return;
    }

    await this.query(
      `DELETE FROM ${table}
       WHERE "userId" = $1 AND "${column}" = ANY($2::uuid[])`,
      [userId, ids],
    );
  }
}
