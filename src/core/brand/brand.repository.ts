import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID } from '~types';

import { BrandEntity } from './brand.entity';

@TypeormRepository(BrandEntity)
export class BrandRepository extends BaseRepository<BrandEntity> {
  /**
   * Resolves brand names to ids, creating nothing.
   *
   * This is the lookup a per-user blacklist needs, as opposed to
   * `getOrCreateByName`: the brand a person hides is one the catalogue already
   * carries, so an unmatched name is a bad request rather than a brand to coin
   * — and a typo must not mint a row that every other user's brand list then
   * reads.
   *
   * @param names - Brand names; blanks and duplicates are ignored.
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
      'SELECT id, name FROM brand WHERE name = ANY($1)',
      [keys],
    ) as { id: ID; name: string }[];

    return new Map(rows.map((row) => [row.name, row.id]));
  }
}
