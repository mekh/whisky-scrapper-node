import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID, TypeBrand } from '~types';

import { BrandEntity } from './brand.entity';

/**
 * Autocomplete search over brand names. No stock filter on purpose: a brand
 * row exists only because some product referenced it, and a brand rule
 * legitimately outlives the stock. Prefix matches rank first, then the
 * shortest name, so `glen` offers `Glen Grant` above `Glenmorangie`.
 */
const SEARCH_SQL = `
  SELECT name FROM brand
  WHERE name ILIKE '%' || $1 || '%'
  ORDER BY (name ILIKE $1 || '%') DESC, length(name), name
  LIMIT $2
`;

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

  /**
   * Autocomplete search over brand names; see `SEARCH_SQL` for the ordering.
   *
   * @param term - The substring to look for; the caller enforces the minimum
   *   length.
   * @param limit - Rows to return at most.
   * @returns Matching brands, best matches first.
   */
  public async searchByName(
    term: string,
    limit: number,
  ): Promise<TypeBrand[]> {
    return this.query(SEARCH_SQL, [term, limit]) as Promise<TypeBrand[]>;
  }
}
