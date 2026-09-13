import { ApiOkResponse } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';

import { RESPONSE_VALIDATION_META_INJECT_TOKEN } from '~constants';
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

/**
 * Whether this route still wants its handler's result converted into DTO
 * instances, the handler's own flag outranking its controller's.
 *
 * It is read when the handler runs rather than when it is decorated: a
 * controller's flag does not exist yet while its methods are decorated, and
 * reading late also makes the answer independent of the order the two
 * decorators are written in.
 *
 * @param handler - The decorated handler, carrying the method-level flag.
 * @param prototype - The controller prototype whose constructor carries the
 *   class-level flag.
 * @returns True unless the handler or its controller opted out.
 */
const isEnabled = (handler: object, prototype: object): boolean => {
  const own = Reflect.getMetadata(
    RESPONSE_VALIDATION_META_INJECT_TOKEN,
    handler,
  ) as boolean | undefined;

  if (own !== undefined) {
    return own;
  }

  const declared = Reflect.getMetadata(
    RESPONSE_VALIDATION_META_INJECT_TOKEN,
    (prototype as { constructor: object }).constructor,
  ) as boolean | undefined;

  return declared ?? true;
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

    descriptor.value = async function wrapped(
      this: unknown,
      ...args: unknown[]
    ): Promise<unknown> {
      const res = await handler.apply(this, args);

      if (!res || !isEnabled(wrapped, target)) {
        return res;
      }

      return resToDto<T>(cls, res);
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
