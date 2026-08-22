import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { Repository } from 'typeorm';

import { ID, Preference } from '~types';

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
      SELECT array_agg(b.name ORDER BY b.name)
      FROM blacklist_brand bb
      JOIN brand b ON b.id = bb."brandId"
      WHERE bb."userId" = $1
    ), '{}') AS "blacklistBrands"
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
   * @param brandIds - Brand ids, deduplicated and sorted.
   */
  public async addBlacklistBrands(userId: ID, brandIds: ID[]): Promise<void> {
    await this.insertMembership(
      'blacklist_brand',
      'brandId',
      userId,
      brandIds,
    );
  }

  /**
   * Un-hides brands; ids that were not hidden are ignored.
   *
   * @param userId - Whose blacklist to trim.
   * @param brandIds - Brand ids to drop.
   */
  public async removeBlacklistBrands(
    userId: ID,
    brandIds: ID[],
  ): Promise<void> {
    await this.deleteMembership(
      'blacklist_brand',
      'brandId',
      userId,
      brandIds,
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
