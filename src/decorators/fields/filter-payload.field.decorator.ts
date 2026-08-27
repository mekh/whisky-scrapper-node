import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsObject,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

import {
  QUICK_FILTER_KEY_MAX_LENGTH,
  QUICK_FILTER_MAX_KEYS,
  QUICK_FILTER_MAX_VALUES_PER_KEY,
  QUICK_FILTER_PAYLOAD_MAX_BYTES,
  QUICK_FILTER_VALUE_MAX_LENGTH,
} from '~constants';

/**
 * Reports whether a value may appear inside a filter payload — a scalar the
 * query string can carry, or null.
 *
 * @param value - One payload value, or one element of an array value.
 * @returns True when the value is a permitted scalar.
 */
const isScalar = (value: unknown): boolean => {
  if (value === null || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return typeof value === 'string'
    && value.length <= QUICK_FILTER_VALUE_MAX_LENGTH;
};

/**
 * Reports whether one payload entry is structurally acceptable: a scalar, or a
 * flat array of scalars within the element cap.
 *
 * @param value - The entry's value.
 * @returns True when the entry is a scalar or a flat scalar array.
 */
const isEntryValid = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length <= QUICK_FILTER_MAX_VALUES_PER_KEY
      && value.every(isScalar);
  }

  return isScalar(value);
};

/**
 * Validates a filter payload's shape without looking at what its keys mean.
 *
 * This is the whole of the backend's opinion about a saved filter set. It
 * bounds what one row can cost and rules out nesting, and it deliberately
 * checks **no** dimension semantics: `/report/:kind` validates every dimension
 * on the request that consumes it, and re-checking here would mean an older
 * backend rejecting a newer client's filter — exactly what this feature must
 * not do.
 *
 * @param value - The candidate payload.
 * @returns True when the payload is a plain object within every limit.
 */
const isPayloadValid = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length > QUICK_FILTER_MAX_KEYS) {
    return false;
  }

  const structurallyValid = entries.every(([key, entry]) =>
    key.length > 0
    && key.length <= QUICK_FILTER_KEY_MAX_LENGTH
    && isEntryValid(entry)
  );

  if (!structurallyValid) {
    return false;
  }

  return Buffer.byteLength(JSON.stringify(value), 'utf8')
    <= QUICK_FILTER_PAYLOAD_MAX_BYTES;
};

/**
 * An opaque filter payload: a flat object of scalars and scalar arrays that
 * this service stores and returns verbatim.
 *
 * It is deliberately a **leaf** property — `@IsObject()` with no
 * `@ValidateNested()`. class-validator's `whitelist` only strips properties of
 * the object it validates and only descends where nesting is declared, so an
 * unknown key inside the payload is neither rejected by the global
 * `forbidNonWhitelisted` pipe nor stripped from the response by the outgoing
 * `ValidationInterceptor`. Declaring a typed payload class would silently
 * break both halves of that.
 *
 * The `@ApiProperty` is the one hand-written Swagger annotation in the
 * codebase: the CLI plugin cannot infer a useful schema for an index-signature
 * type, and without it the generated client types the field as `unknown`.
 *
 * @param validationOptions - Standard class-validator options.
 * @returns A property decorator for an opaque filter payload field.
 */
export const FilterPayload = (
  validationOptions?: ValidationOptions,
): PropertyDecorator =>
  applyDecorators(
    IsObject(validationOptions),
    ApiProperty({
      type: 'object',
      additionalProperties: true,
      description: "Opaque filter payload; keys are the client's "
        + 'filter dimensions.',
    }),
    (target: object, propertyName: string | symbol): void => {
      registerDecorator({
        name: 'filterPayload',
        target: target.constructor,
        propertyName: propertyName as string,
        options: validationOptions,
        validator: {
          validate: (value: unknown): boolean => isPayloadValid(value),
          defaultMessage: (args?: ValidationArguments): string =>
            `${args?.property ?? 'filters'} must be a flat object of scalars `
            + `or scalar arrays, at most ${QUICK_FILTER_MAX_KEYS} keys and `
            + `${QUICK_FILTER_PAYLOAD_MAX_BYTES} bytes`,
        },
      });
    },
  );
