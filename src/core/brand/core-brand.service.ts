import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { BrandEntity } from './brand.entity';
import { BrandRepository } from './brand.repository';

/**
 * Persistence-layer public API for the `brand` entity.
 */
@Injectable()
export class CoreBrandService extends CoreBaseService<BrandEntity> {
  protected readonly uniqueFields: 'name'[] = ['name'];

  public constructor(protected readonly repo: BrandRepository) {
    super(repo);
  }

  /**
   * Resolves brand names to ids, creating any missing ones. This is the scrape
   * path; anything driven by a request wants `findIdsByName` instead, which
   * cannot mint a brand from a typo.
   *
   * @param names - Brand names; blanks and duplicates are ignored.
   * @returns Map from each present name to its id.
   */
  public async resolveByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.getOrCreateByName(names);
  }

  /**
   * Resolves brand names to ids without creating the missing ones.
   *
   * @param names - Brand names; blanks and duplicates are ignored.
   * @returns Map from each matched name to its id; unknown names are absent.
   */
  public async findIdsByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.findIdsByName(names);
  }

  /**
   * Every canonical brand name in the catalogue. The scrape engine matches
   * product names against these to recover a brand the store did not state.
   *
   * @returns All brand names, in no particular order.
   */
  public async listNames(): Promise<string[]> {
    const rows = await this.findMany(undefined, { select: { name: true } });

    return rows.map((row) => row.name);
  }
}
