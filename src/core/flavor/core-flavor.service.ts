import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { FlavorEntity } from './flavor.entity';
import { FlavorRepository } from './flavor.repository';

/**
 * Persistence-layer public API for the `flavor` entity.
 */
@Injectable()
export class CoreFlavorService extends CoreBaseService<FlavorEntity> {
  protected readonly uniqueFields: 'name'[] = ['name'];

  public constructor(protected readonly repo: FlavorRepository) {
    super(repo);
  }

  /**
   * Resolves flavor names to ids, creating any missing ones.
   *
   * @param names - Flavor names; blanks and duplicates are ignored.
   * @returns Map from each present name to its id.
   */
  public async resolveByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.getOrCreateByName(names);
  }

  /**
   * Lists every flavor name, alphabetically.
   *
   * @returns Sorted flavor names.
   */
  public async allNames(): Promise<string[]> {
    const rows = await this.findMany(undefined, { order: { name: 'ASC' } });

    return rows.map((row) => row.name);
  }
}
