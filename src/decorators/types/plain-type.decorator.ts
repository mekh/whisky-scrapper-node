import { ApiOkResponse } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';

import { ServerError } from '~errors';
import { AuthPermission as Perm, Cls } from '~types';
import { Permission } from '../auth';

export type Handler<T> = (
  ...args: unknown[]
) => Promise<Partial<T> | undefined>;

// A single positional permission (`Perm`), or several permissions spread
// as separate arguments (`Perm[]`, combined with `OR`).
type Perms = Perm | Perm[];

const resToDto = <T>(
  type: Cls<T> | Cls<T>[],
  rawData?: Partial<T> | Partial<T>[],
): T | T[] => {
  const isArray = Array.isArray(type);
  const typeCls = isArray ? type[0] : type;

  if (rawData && !isArray) {
    const dto = new typeCls();
    Object.assign(dto as object, plainToInstance(type, rawData));

    return dto;
  }

  if (Array.isArray(rawData)) {
    return rawData.map(
      (item) => {
        const dto = new typeCls();
        Object.assign(dto as object, plainToInstance(typeCls, item));

        return dto;
      },
    );
  }

  throw new ServerError('Invalid response');
};

const copyMeta = <T>(source: Handler<T>, target: Handler<T>): void => {
  Reflect.getMetadataKeys(source).forEach((key) => {
    const prevMeta = Reflect.getMetadata(key, source);

    Reflect.defineMetadata(key, prevMeta, target);
  });

  Object.defineProperty(target, 'name', {
    value: source.name,
    writable: false,
  });
};

export function Plain<T>(
  cls: Cls<T> | Cls<T>[],
  ...perms: Perms
): MethodDecorator {
  return (
    target: object,
    propertyKey: symbol | string,
    descriptor: PropertyDescriptor,
  ) => {
    const handler: Handler<T> = descriptor.value;

    descriptor.value = async function(
      this: unknown,
      ...args: unknown[]
    ): Promise<unknown> {
      const res = await handler.apply(this, args);

      return res ? resToDto<T>(cls, res) : res;
    };

    copyMeta(handler, descriptor.value as Handler<T>);

    Permission(
      ...perms as Parameters<typeof Permission>,
    )(target, propertyKey, descriptor);

    const isArray = Array.isArray(cls);
    const model = (isArray ? cls[0] : cls) as Cls<T>;

    ApiOkResponse({ type: model, isArray })(
      target,
      propertyKey,
      descriptor,
    );
  };
}
