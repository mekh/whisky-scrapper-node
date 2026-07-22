import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

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
   * Lists every whisky type name, alphabetically.
   *
   * @returns Sorted type names.
   */
  public async allNames(): Promise<string[]> {
    const rows = await this.findMany(undefined, { order: { name: 'ASC' } });

    return rows.map((row) => row.name);
  }
}
