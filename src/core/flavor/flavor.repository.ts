import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID } from '~types';

import { FlavorEntity } from './flavor.entity';

@TypeormRepository(FlavorEntity)
export class FlavorRepository extends BaseRepository<FlavorEntity> {
  /**
   * Resolves flavor names to ids, creating nothing.
   *
   * This is the lookup a manual edit needs, as opposed to
   * `getOrCreateByName`: the tag set a person picks comes from the list `/meta`
   * published, so a name that is absent here is a bad request rather than a new
   * flavor to coin — and typos must not litter the reference table every other
   * product's filter reads from.
   *
   * @param names - Flavor names; blanks and duplicates are ignored.
   * @returns Map from each matched name to its id; unknown names are absent.
   */
  public async findIdsByName(names: string[]): Promise<Map<string, ID>> {
    const keys = [
      ...new Set(
        names
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      ),
    ];

    if (!keys.length) {
      return new Map();
    }

    const rows = await this.query(
      'SELECT id, name FROM flavor WHERE name = ANY($1)',
      [keys],
    ) as { id: ID; name: string }[];

    return new Map(rows.map((row) => [row.name, row.id]));
  }
}
