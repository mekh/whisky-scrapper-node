import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { TypeEntity } from './type.entity';
import { TypeRepository } from './type.repository';

/**
 * Persistence-layer public API for the `type` (whisky type) entity.
 */
@Injectable()
export class CoreTypeService extends CoreBaseService<TypeEntity> {
  protected readonly uniqueFields: 'name'[] = ['name'];

  public constructor(protected readonly repo: TypeRepository) {
    super(repo);
  }

  /**
   * Resolves whisky-type names to ids, creating any missing ones.
   *
   * @param names - Type names; blanks and duplicates are ignored.
   * @returns Map from each present name to its id.
   */
  public async resolveByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.getOrCreateByName(names);
  }

  /**
   * Lists every whisky type name, alphabetically.
   *
   * @returns Sorted type names.
   */
  public async allNames(): Promise<string[]> {
    const rows = await this.findMany(undefined, { order: { name: 'ASC' } });

    return rows.map((row) => row.name);
  }
}
