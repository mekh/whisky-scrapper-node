import { InsertResult, QueryDeepPartialEntity, Repository } from 'typeorm';

import { EntityBase } from '~types';

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
}
