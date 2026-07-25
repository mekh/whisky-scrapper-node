import { InsertResult, QueryDeepPartialEntity, Repository } from 'typeorm';

import { DEFAULT_CHUNK_SIZE } from '~constants';
import { EntityBase, ID } from '~types';
import { ArrayUtils } from '~utils';

export class BaseRepository<
  Entity extends EntityBase,
> extends Repository<Entity> {
  public get name(): string {
    return this.constructor.name.replace(/Repository$/, '');
  }

  public async createOrIgnore(
    input: QueryDeepPartialEntity<Entity> | QueryDeepPartialEntity<Entity>[],
  ): Promise<InsertResult> {
    const data = Array.isArray(input) ? input : [input];

    return this.createQueryBuilder()
      .insert()
      .values(data)
      .orIgnore()
      .updateEntity(false)
      .execute();
  }

  /**
   * Resolves a set of lookup names to ids, creating any that do not yet exist.
   * Requires the entity to have a unique `name` column (brand/type/flavor);
   * names are deduplicated and blanks dropped. Two round-trips regardless of
   * count: a chunked `INSERT ... ON CONFLICT DO NOTHING`, then one read-back.
   *
   * @param names - Lookup names to resolve; blanks and duplicates are ignored.
   * @returns Map from each present name to its id.
   */
  public async getOrCreateByName(names: string[]): Promise<Map<string, ID>> {
    const distinct = [...new Set(names.filter((name) => name.length > 0))];

    if (!distinct.length) {
      return new Map();
    }

    const table = this.metadata.tableName;

    for (const chunk of ArrayUtils.chunkify(distinct, DEFAULT_CHUNK_SIZE)) {
      const values = chunk.map((_, index) => `($${index + 1})`).join(', ');

      await this.query(
        `INSERT INTO "${table}" (name) VALUES ${values} `
          + 'ON CONFLICT (name) DO NOTHING',
        chunk,
      );
    }

    const rows = await this.query(
      `SELECT id, name FROM "${table}" WHERE name = ANY($1)`,
      [distinct],
    ) as { id: ID; name: string }[];

    return new Map(rows.map((row) => [row.name, row.id]));
  }
}
