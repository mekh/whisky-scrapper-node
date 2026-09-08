import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';

import { IsDateFormat } from './is-date-format.field.decorator';

/**
 * Query or body field holding a bare calendar day as `YYYY-MM-DD`.
 *
 * Deliberately stricter than `@IsDateString()`, which accepts any ISO-8601
 * value — a full timestamp like `2026-08-21T22:00:00Z` names an ambiguous
 * day depending on the timezone it is read in, so only the ten-character
 * date form passes. Since it delegates to {@link IsDateFormat} it is also
 * stricter than the shape check it used to be: `2026-99-99` and the
 * non-existent `2026-02-30` are rejected here rather than reaching Postgres
 * and failing there as a `500`.
 *
 * @param optional - When true, the field may be absent.
 * @returns A property decorator for a `YYYY-MM-DD` field.
 */
export const IsoDate = (optional = false): PropertyDecorator =>
  applyDecorators(
    ...optional ? [IsOptional()] : [],
    IsString(),
    IsDateFormat('YYYY-MM-DD'),
  );
