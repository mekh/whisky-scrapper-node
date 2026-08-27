import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { QueryDeepPartialEntity } from 'typeorm';

import type { ID, QuickFilter, QuickFilterUpdateInput } from '~types';

import { BaseRepository } from '../_common';
import { QuickFilterEntity } from './quick-filter.entity';

/**
 * `QueryDeepPartialEntity` maps every object property recursively, so it turns
 * the opaque `jsonb` payload into a deep-partial of itself and then rejects the
 * `unknown` values it is made of. A `jsonb` column is written whole, not
 * merged, so the mapping does not describe it — hence one cast, here, rather
 * than a weaker type on the payload everywhere else.
 *
 * @param values - The columns to write.
 * @returns The same object, typed as TypeORM's write shape.
 */
const asWriteValues = (
  values: Partial<Pick<QuickFilter, 'name' | 'filters'>> & { userId?: ID },
): QueryDeepPartialEntity<QuickFilterEntity> =>
  values as QueryDeepPartialEntity<QuickFilterEntity>;

/**
 * The columns a filter set is exposed by. `userId` is deliberately absent: the
 * caller always knows whose sets it asked for, and leaving the column out of
 * the projection keeps it from having to be stripped again downstream.
 */
const PUBLIC_COLUMNS = [
  'qf.id',
  'qf.name',
  'qf.filters',
  'qf.createdAt',
  'qf.updatedAt',
];

/**
 * Owns the `quick_filter` table. Every read is scoped by `userId` and every
 * write is scoped by `(id, userId)`, so a foreign id simply matches no row —
 * which is what lets the service answer 404 instead of leaking that the set
 * exists and belongs to someone else.
 */
@TypeormRepository(QuickFilterEntity)
export class QuickFilterRepository extends BaseRepository<QuickFilterEntity> {
  /**
   * Lists a user's filter sets, ordered case-insensitively by name.
   *
   * The ordering is part of the API contract: the client renders the list as
   * given, and `ORDER BY name` alone would sort «Айла» against «айла» by byte.
   *
   * @param userId - Whose sets to list.
   * @returns The sets, alphabetically; empty when the user saved none.
   */
  public async findByUserId(userId: ID): Promise<QuickFilter[]> {
    return this.createQueryBuilder('qf')
      .select(PUBLIC_COLUMNS)
      .where('qf."userId" = :userId', { userId })
      .orderBy('lower(qf.name)', 'ASC')
      .getMany();
  }

  /**
   * Counts a user's filter sets, for the per-user cap.
   *
   * @param userId - Whose sets to count.
   * @returns The number of sets the user holds.
   */
  public async countByUserId(userId: ID): Promise<number> {
    return this.countBy({ userId });
  }

  /**
   * Finds a user's set by name, ignoring case — the duplicate-name check.
   *
   * @param userId - Whose sets to search.
   * @param name - The candidate name, already whitespace-normalized.
   * @returns The colliding set's id and name, or null when the name is free.
   */
  public async findByUserAndNameCi(
    userId: ID,
    name: string,
  ): Promise<Pick<QuickFilter, 'id' | 'name'> | null> {
    return this.createQueryBuilder('qf')
      .select(['qf.id', 'qf.name'])
      .where('qf."userId" = :userId', { userId })
      .andWhere('lower(qf.name) = lower(:name)', { name })
      .getOne();
  }

  /**
   * Inserts one filter set.
   *
   * @param userId - The owner.
   * @param input - The set's name and payload.
   * @throws {QueryFailedError} With driver code `23505` when the name races
   *   another insert of the same user.
   */
  public async insertForUser(
    userId: ID,
    input: Pick<QuickFilter, 'name' | 'filters'>,
  ): Promise<void> {
    await this.insert(asWriteValues({ userId, ...input }));
  }

  /**
   * Applies a patch to one of a user's sets.
   *
   * @param id - The set to patch.
   * @param userId - Its owner; a mismatch matches no row.
   * @param patch - The fields to change; an absent field is left alone.
   * @returns True when a row was updated, false when the pair matched none.
   * @throws {QueryFailedError} With driver code `23505` on a name collision.
   */
  public async updateForUser(
    id: ID,
    userId: ID,
    patch: QuickFilterUpdateInput,
  ): Promise<boolean> {
    const result = await this.update({ id, userId }, asWriteValues(patch));

    return !!result.affected;
  }

  /**
   * Deletes one of a user's sets.
   *
   * @param id - The set to delete.
   * @param userId - Its owner; a mismatch matches no row.
   * @returns True when a row was deleted, false when the pair matched none.
   */
  public async deleteForUser(id: ID, userId: ID): Promise<boolean> {
    const result = await this.delete({ id, userId });

    return !!result.affected;
  }
}
