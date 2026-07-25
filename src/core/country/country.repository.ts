import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID } from '~types';

import { CountryEntity } from './country.entity';

@TypeormRepository(CountryEntity)
export class CountryRepository extends BaseRepository<CountryEntity> {
  /**
   * Resolves Ukrainian country names to ids, case- and whitespace-insensitive.
   * Lookup only: the country table is a fixed reference set, so unknown names
   * are simply absent from the result (the product's country stays null).
   *
   * @param names - Ukrainian country names to resolve.
   * @returns Map from each matched name (trimmed, lower-cased) to its id.
   */
  public async resolveByNameUa(names: string[]): Promise<Map<string, ID>> {
    const keys = [
      ...new Set(
        names
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name.length > 0),
      ),
    ];

    if (!keys.length) {
      return new Map();
    }

    const rows = await this.query(
      'SELECT id, lower("nameUa") AS key FROM country '
        + 'WHERE lower("nameUa") = ANY($1)',
      [keys],
    ) as { id: ID; key: string }[];

    return new Map(rows.map((row) => [row.key, row.id]));
  }
}
