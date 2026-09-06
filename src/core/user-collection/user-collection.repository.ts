import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { QueryDeepPartialEntity } from 'typeorm';

import { ServerError } from '~errors';
import type { CollectionRow, CollectionRowResolved, ID } from '~types';

import { BaseRepository } from '../_common';
import { UserCollectionEntity } from './user-collection.entity';

/**
 * `CollectionRowResolved`'s fields clear through an explicit `null`, while the
 * entity's own column types only ever admit `undefined` (the nullable-column
 * convention every entity in this codebase uses) — so a plain object literal
 * typed against `CollectionRowResolved` does not satisfy
 * `QueryDeepPartialEntity<UserCollectionEntity>` on its own. The write is a
 * flat set of scalar columns, never nested, so the cast is exactly as safe as
 * `QuickFilterRepository`'s `asWriteValues`.
 *
 * @param values - The columns to write.
 * @returns The same object, typed as TypeORM's write shape.
 */
const asWriteValues = (
  values: CollectionRowResolved & { userId?: ID; productId?: ID },
): QueryDeepPartialEntity<UserCollectionEntity> =>
  values as QueryDeepPartialEntity<UserCollectionEntity>;

/**
 * Projects one collection row plus everything a card needs to render it: the
 * bottling's own facts, one representative store name, and its flavour tags.
 * Callers append their own `WHERE` (and `ORDER BY`) clause.
 *
 * `LEFT JOIN LATERAL`, not `JOIN`, against `store_product`: a bottling no shop
 * lists any more must still render — that is the point of a personal
 * collection surviving a whisky leaving the shelves — and an inner join would
 * drop such a row entirely. The tie-break (`"inStock" DESC, "lastSeen" DESC,
 * id`) is the same one `findOfferRefById` and `PreferenceRepository`'s details
 * read use, so every screen agrees on which store's raw name stands for a
 * bottling.
 *
 * `rating` and `abv` are cast to `::float8`: `rating` is `numeric`, which the
 * raw driver never parses to a number, and `abv` is `real` — the same cast
 * `PreferenceRepository`'s `DETAILS_PRODUCTS_SQL` already applies, for the
 * identical reason.
 */
const COLLECTION_ROW_SQL = `
  SELECT uc.id, uc."productId", uc.rating::float8 AS rating, uc.barcode,
         uc.notes, uc.nose, uc.palate, uc.finish,
         uc."createdAt", uc."updatedAt",
         p.name, o."nameOrig", p.age, p.abv::float8 AS abv, p."volumeMl",
         COALESCE(pr.name, bo.name) AS brand, pr.name AS distillery,
         bo.name AS bottler, t.name AS type,
         c.code AS "countryCode", c."nameUa" AS "countryName",
         c.icon AS "countryIcon", pr.region AS region,
         COALESCE((
           SELECT array_agg(f.name ORDER BY f.name)
           FROM product_flavor pf
           JOIN flavor f ON f.id = pf."flavorId"
           WHERE pf."productId" = p.id
         ), '{}') AS flavors
  FROM user_collection uc
  JOIN product p ON p.id = uc."productId"
  LEFT JOIN producer pr ON pr.id = p."producerId"
  LEFT JOIN producer bo ON bo.id = p."bottlerId"
  LEFT JOIN type t ON t.id = p."typeId"
  LEFT JOIN country c ON c.id = p."countryId"
  LEFT JOIN LATERAL (
    SELECT sp."nameOrig"
    FROM store_product sp
    WHERE sp."productId" = p.id
    ORDER BY sp."inStock" DESC, sp."lastSeen" DESC, sp.id
    LIMIT 1
  ) o ON true
`;

/**
 * Owns the `user_collection` table. Every read is scoped by `userId` and
 * every write is scoped by `(id, userId)`, so a foreign id simply matches no
 * row — the same 404-by-construction shape `QuickFilterRepository` uses.
 */
@TypeormRepository(UserCollectionEntity)
export class UserCollectionRepository
  extends BaseRepository<UserCollectionEntity> {
  /**
   * Lists a user's collection, newest first.
   *
   * @param userId - Whose collection to list.
   * @returns The rows; empty when the user has added nothing yet.
   */
  public async findByUserId(userId: ID): Promise<CollectionRow[]> {
    return this.query(
      `${COLLECTION_ROW_SQL}
       WHERE uc."userId" = $1
       ORDER BY uc."createdAt" DESC, uc.id`,
      [userId],
    ) as Promise<CollectionRow[]>;
  }

  /**
   * Loads one collection row belonging to a user.
   *
   * @param id - The row to load.
   * @param userId - Its claimed owner; a mismatch matches no row.
   * @returns The row, or null when the pair matches none.
   */
  public async findByIdForUser(
    id: ID,
    userId: ID,
  ): Promise<CollectionRow | null> {
    const rows = await this.query(
      `${COLLECTION_ROW_SQL}
       WHERE uc.id = $1 AND uc."userId" = $2`,
      [id, userId],
    ) as CollectionRow[];

    return rows[0] ?? null;
  }

  /**
   * Loads a user's collection row for one bottling, when they hold it.
   *
   * @param productId - The bottling to look up.
   * @param userId - Whose collection to search.
   * @returns The row, or null when the user does not hold this bottling.
   */
  public async findByProductForUser(
    productId: ID,
    userId: ID,
  ): Promise<CollectionRow | null> {
    const rows = await this.query(
      `${COLLECTION_ROW_SQL}
       WHERE uc."productId" = $1 AND uc."userId" = $2`,
      [productId, userId],
    ) as CollectionRow[];

    return rows[0] ?? null;
  }

  /**
   * Lists the bottlings a user already holds, for a catalogue's "already in
   * collection" mark — cheap on purpose, unlike `findByUserId`.
   *
   * @param userId - Whose collection to read.
   * @returns The bottling ids, ordered by id; empty when the user holds none.
   */
  public async findProductIdsByUserId(userId: ID): Promise<ID[]> {
    const rows = await this.query(
      `SELECT "productId" FROM user_collection
       WHERE "userId" = $1
       ORDER BY "productId"`,
      [userId],
    ) as { productId: ID }[];

    return rows.map((row) => row.productId);
  }

  /**
   * Adds a bottling to a user's collection.
   *
   * @param userId - The owner.
   * @param productId - The bottling to add.
   * @param values - The row's own fields (rating, notes, ...).
   * @returns The new row's id.
   * @throws {ServerError} When the driver returns no identifier.
   * @throws {QueryFailedError} With driver code `23505` when the user already
   *   holds this bottling.
   */
  public async insertForUser(
    userId: ID,
    productId: ID,
    values: CollectionRowResolved,
  ): Promise<ID> {
    const result = await this.insert(
      asWriteValues({ userId, productId, ...values }),
    );

    const id = result.identifiers[0]?.id as ID | undefined;

    if (!id) {
      throw new ServerError('Insert returned no identifier', { productId });
    }

    return id;
  }

  /**
   * Applies a patch to one of a user's collection rows.
   *
   * An empty patch is a no-op, not an error: it never reaches the database,
   * so it can never (mis)report "not found" for a row that exists but simply
   * had nothing to change.
   *
   * @param id - The row to patch.
   * @param userId - Its owner; a mismatch matches no row.
   * @param values - The columns to change; an absent field is left alone.
   * @returns True when a row was updated, false when the pair matched none.
   */
  public async updateForUser(
    id: ID,
    userId: ID,
    values: CollectionRowResolved,
  ): Promise<boolean> {
    if (!Object.keys(values).length) {
      return true;
    }

    const result = await this.update({ id, userId }, asWriteValues(values));

    return !!result.affected;
  }

  /**
   * Deletes one of a user's collection rows.
   *
   * @param id - The row to delete.
   * @param userId - Its owner; a mismatch matches no row.
   * @returns True when a row was deleted, false when the pair matched none.
   */
  public async deleteForUser(id: ID, userId: ID): Promise<boolean> {
    const result = await this.delete({ id, userId });

    return !!result.affected;
  }

  /**
   * Confirms a collection row belongs to a user, without loading the rest of
   * it — the ownership check a child purchase write runs before touching
   * anything.
   *
   * @param id - The collection row to check.
   * @param userId - Its claimed owner; a mismatch matches no row.
   * @returns The row's own id when the pair matches, else null.
   */
  public async findIdForUser(id: ID, userId: ID): Promise<ID | null> {
    const row = await this.findOne({
      where: { id, userId },
      select: { id: true },
    });

    return row?.id ?? null;
  }
}
