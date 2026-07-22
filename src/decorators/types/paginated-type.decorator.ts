import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, Min, ValidateNested } from 'class-validator';

import { AuthPermission, Cls, TypePaginated } from '~types';
import { Permission } from '../auth';
import { Plain } from './plain-type.decorator';

type Params<T> =
  | [Cls<T>, ...AuthPermission]
  | [Cls<T>, ...AuthPermission[]];

const reg = new Map<string, Cls<TypePaginated<any>>>();

const getOrCreatePaginatedType = <T>(
  cls: Cls<T>,
): Cls<TypePaginated<T>> => {
  if (reg.has(cls.name)) {
    return reg.get(cls.name)! as Cls<TypePaginated<T>>;
  }

  class PaginatedData {
    @Type(() => cls)
    @IsArray()
    @ValidateNested({ each: true })
    declare public readonly data: T[];

    @IsInt()
    @Min(0)
    declare public readonly total: number;

    @IsInt()
    @Min(0)
    declare public readonly limit: number;

    @IsInt()
    @Min(0)
    declare public readonly offset: number;
  }

  return PaginatedData;
};

export function Paginated<T>(...params: Params<T>): MethodDecorator {
  const [cls, ...perms] = params;

  return (
    target: object,
    propertyKey: symbol | string,
    descriptor: PropertyDescriptor,
  ) => {
    const paginatedType = getOrCreatePaginatedType(cls);

    Plain(
      paginatedType,
      ...perms as Parameters<typeof Permission>,
    )(target, propertyKey, descriptor);

    /**
     * `Plain` above documents the (dynamic, unannotated) paginated wrapper for
     * the 200 response. Override it with an explicit envelope schema whose
     * `data` items reference the real item DTO so the generated client gets the
     * correct row type. `ApiExtraModels` registers that DTO as a component so
     * `getSchemaPath` resolves.
     */
    ApiExtraModels(cls)(target, propertyKey, descriptor);

    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['data', 'total', 'limit', 'offset'],
        properties: {
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(cls) },
          },
          total: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 0 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
    })(target, propertyKey, descriptor);
  };
}
