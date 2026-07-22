import {
  DeepPartial,
  DeleteResult,
  FindManyOptions,
  FindOptionsOrder,
  FindOptionsSelect,
  FindOptionsWhere,
  In,
  InsertResult,
  QueryDeepPartialEntity,
  UpdateResult,
} from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  DEFAULT_PAGE_ORDER,
} from '~constants';
import { DuplicateError, NotFoundError } from '~errors';
import {
  EntityBaseRich,
  EntityCreateInputBase,
  EntityCreateManyResult,
  EntityFindInput,
  EntityUpdateInputBase,
  PaginatedInput,
  TypePaginated,
} from '~types';
import { ArrayUtils } from '~utils';

import { BaseRepository } from './base.repository';

export class CoreBaseService<Entity extends EntityBaseRich> {
  protected readonly uniqueFields: (keyof EntityCreateInputBase<Entity>)[] = [];

  private readonly INSERT_BATCH_SIZE = DEFAULT_CHUNK_SIZE;

  constructor(protected readonly repo: BaseRepository<Entity>) {}

  /**
   * Returns a page of entities ordered by the requested column.
   *
   * @param query - Pagination bounds and ordering; each field falls back to
   *   a default (`limit` {@link DEFAULT_PAGE_LIMIT}, `offset`
   *   {@link DEFAULT_PAGE_OFFSET}, `orderBy` `createdAt`, `order`
   *   {@link DEFAULT_PAGE_ORDER}) when omitted.
   * @returns The requested slice plus the total count and the effective
   *   `limit`/`offset` that were applied.
   */
  public async list(
    query: PaginatedInput<Entity>,
  ): Promise<TypePaginated<Entity>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = query.offset ?? DEFAULT_PAGE_OFFSET;
    const orderBy: keyof Entity = query.orderBy ?? 'id';

    const [data, total] = await this.repo.findAndCount({
      take: limit,
      skip: offset,
      order: {
        [orderBy]: query.order ?? DEFAULT_PAGE_ORDER,
      } as FindOptionsOrder<Entity>,
    });

    return { data, total, limit, offset };
  }

  /**
   * Loads one entity by id, or all entities matching a list of ids.
   *
   * @param id - A single id, or an array of ids to load in bulk.
   * @returns The matching entity (or `undefined`) for a single id; the array
   *   of found entities for a list of ids.
   */
  public async findById(id: Entity['id']): Promise<Entity | undefined>;
  public async findById(id: Entity['id'][]): Promise<Entity[]>;
  public async findById(
    id: Entity['id'] | Entity['id'][],
  ): Promise<Entity | Entity[] | undefined> {
    if (Array.isArray(id)) {
      return this.repo.find({
        where: { id: In(id) } as FindOptionsWhere<Entity>,
      });
    }

    const doc = await this.repo.findOne({
      where: { id } as FindOptionsWhere<Entity>,
    });

    return doc ?? undefined;
  }

  public async findByIdOrThrow(id: Entity['id']): Promise<Entity>;
  public async findByIdOrThrow(id: Entity['id'][]): Promise<Entity[]>;
  public async findByIdOrThrow(
    id: Entity['id'] | Entity['id'][],
  ): Promise<Entity | Entity[]> {
    const isArray = Array.isArray(id);

    const ids = isArray ? id : [id];
    const unique = [...new Set(ids)];
    const res = await this.findById(unique);

    if (!isArray && !res.length) {
      throw new NotFoundError(`${this.repo.name} not found`, { id });
    }

    if (res.length === unique.length) {
      return isArray ? res : res[0];
    }

    const set = res.reduce(
      (acc, { id }) => acc.add(id),
      new Set(),
    );

    const unknownIds = unique.filter(
      (id) => !set.has(id),
    );

    throw new NotFoundError(
      `one or more ${this.repo.name}s were not found`,
      { ids: unknownIds },
    );
  }

  public async findMany(
    input?: EntityFindInput<Entity>,
    options?: Omit<FindManyOptions<Entity>, 'where'>,
  ): Promise<Entity[]> {
    return this.repo.find({ where: input, ...options });
  }

  public async findOne(
    input?: EntityFindInput<Entity>,
    options?: Omit<FindManyOptions<Entity>, 'where'>,
  ): Promise<Entity | null> {
    return this.repo.findOne({ where: input, ...options });
  }

  public createOrIgnore(
    input: EntityCreateInputBase<Entity> | EntityCreateInputBase<Entity>[],
  ): Promise<InsertResult> {
    return this.repo.createOrIgnore(input as QueryDeepPartialEntity<Entity>);
  }

  public async createOne(
    input: EntityCreateInputBase<Entity>,
  ): Promise<Entity> {
    await this.beforeCreate(input);

    const doc = this.repo.create(input as DeepPartial<Entity>);

    await this.repo.save(doc);

    return this.findByIdOrThrow(doc.id);
  }

  @Transactional()
  public async createMany(
    input: EntityCreateInputBase<Entity>[],
    batchSize = this.INSERT_BATCH_SIZE,
    throwOnError = true,
  ): Promise<EntityCreateManyResult> {
    if (!input.length) {
      return { success: true, identifiers: [] };
    }

    const errors: string[] = [];
    const chunks = ArrayUtils.chunkify(input, batchSize);
    let success = true;

    await this.beforeCreate(input);

    const identifiers: Entity['id'][] = [];
    for (const batch of chunks) {
      try {
        const data = this.repo.create(batch as DeepPartial<Entity>[]);
        const res = await this.repo.insert(
          data as QueryDeepPartialEntity<Entity>[],
        );

        identifiers.push(
          ...res.identifiers.map((item) => item.id as Entity['id']),
        );
      } catch (error: unknown) {
        if (throwOnError) {
          throw error;
        }

        success = false;
        errors.push((error as Error).message);
      }
    }

    return { identifiers, success, ...errors.length && { errors } };
  }

  public async updateById(
    id: Entity['id'],
    input: EntityUpdateInputBase<Entity>,
  ): Promise<Entity | undefined> {
    const doc = await this.findById(id);
    if (!doc) {
      return;
    }

    return this.mergeAndSave(doc, input);
  }

  public async updateByIdOrThrow(
    id: Entity['id'],
    input: EntityUpdateInputBase<Entity>,
  ): Promise<Entity> {
    const doc = await this.findByIdOrThrow(id);

    return this.mergeAndSave(doc, input);
  }

  public async update(
    criteria: Entity['id'] | Entity['id'][] | FindOptionsWhere<Entity>,
    input: EntityUpdateInputBase<Entity>,
  ): Promise<UpdateResult> {
    return this.repo.update(criteria, input as QueryDeepPartialEntity<Entity>);
  }

  public async deleteById(id: Entity['id']): Promise<DeleteResult> {
    return this.repo.delete(id);
  }

  public async deleteByIds(ids: Entity['id'][]): Promise<DeleteResult> {
    if (!ids.length) {
      return { affected: 0, raw: null };
    }

    return this.repo.delete(ids);
  }

  protected async mergeAndSave(
    doc: Entity,
    update: EntityUpdateInputBase<Entity>,
  ): Promise<Entity> {
    Object.entries(update).forEach(
      ([key, value]) => {
        doc[key as keyof Entity] = value as any;
      },
    );

    doc.updatedAt = new Date();

    return this.repo.save(doc);
  }

  protected async beforeCreate(
    input: EntityCreateInputBase<Entity> | EntityCreateInputBase<Entity>[],
  ): Promise<void> {
    if (!this.uniqueFields.length) {
      return;
    }

    const data = Array.isArray(input) ? input : [input];
    const duplicatedKeys = new Set<keyof EntityCreateInputBase<Entity>>();

    const map = data.reduce(
      (acc, item) => {
        this.uniqueFields.forEach((field) => {
          if (item[field] === undefined) {
            return;
          }

          const values = acc.get(field) ?? new Set();
          if (values.has(item[field])) {
            duplicatedKeys.add(field);

            return;
          }

          acc.set(field, values.add(item[field]));
        });

        return acc;
      },
      new Map<keyof EntityCreateInputBase<Entity>, Set<unknown>>(),
    );

    if (duplicatedKeys.size) {
      throw new DuplicateError(
        'Duplicate entity',
        { keys: [...duplicatedKeys] },
      );
    }

    const query = [...map.entries()]
      .filter(([, values]) => values.size)
      .map(([field, values]) => [field, In([...values])]);

    if (!query.length) {
      return;
    }
    const select = [
      'id',
      ...this.uniqueFields,
    ] as unknown as FindOptionsSelect<Entity>;

    const dbData = await this.repo.find({
      where: Object.fromEntries(query),
      select,
    });

    if (!dbData.length) {
      return;
    }

    throw new DuplicateError(
      'Duplicated entity',
      { docs: dbData.slice(0, 10), total: dbData.length },
    );
  }
}
