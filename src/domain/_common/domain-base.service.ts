import { DeepPartial } from 'typeorm';

import { CoreBaseService } from '~core/common';
import {
  EntityBaseRich,
  EntityCreateInputBase,
  EntityFindInput,
  EntityUpdateInputBase,
  ID,
  PaginatedInput,
  TypePaginated,
} from '~types';

export class DomainBaseService<Entity extends EntityBaseRich> {
  constructor(
    protected readonly service: CoreBaseService<Entity>,
  ) {}

  public async get(id: ID): Promise<Entity> {
    return this.service.findByIdOrThrow(id);
  }

  public async findOne(
    input?: EntityFindInput<Entity>,
  ): Promise<Entity | null> {
    return this.service.findOne(input);
  }

  public async list(
    query: PaginatedInput<Entity>,
  ): Promise<TypePaginated<Entity>> {
    return this.service.list(query);
  }

  public async create(data: EntityCreateInputBase<Entity>): Promise<Entity>;
  public async create(data: EntityCreateInputBase<Entity>[]): Promise<Entity[]>;
  public async create(
    data: EntityCreateInputBase<Entity> | EntityCreateInputBase<Entity>[],
  ): Promise<Entity | Entity[]> {
    const res = Array.isArray(data)
      ? await this.service.createMany(data as DeepPartial<Entity>[])
      : await this.service.createOne(data);

    return 'identifiers' in res
      ? this.service.findById(res.identifiers)
      : res;
  }

  public async update(
    id: ID,
    data: EntityUpdateInputBase<Entity>,
  ): Promise<Entity> {
    await this.service.findByIdOrThrow(id);

    const res = await this.service.updateById(id, data);

    return res!;
  }

  public async delete(id: ID): Promise<void> {
    await this.service.deleteById(id);
  }
}
