import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

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
   * Lists every flavor name, alphabetically.
   *
   * @returns Sorted flavor names.
   */
  public async allNames(): Promise<string[]> {
    const rows = await this.findMany(undefined, { order: { name: 'ASC' } });

    return rows.map((row) => row.name);
  }
}
