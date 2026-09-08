import { applyDecorators } from '@nestjs/common';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import type { SafeTextOptions } from '~types';

/**
 * Every character must be a non-control one (`\P{Cc}` is the complement of
 * Unicode's control category, so both the C0 block and the C1 block are
 * rejected). Used for a field holding one line — a shop name, a label —
 * where a line break is not content but a way to forge a second line in
 * whatever renders the value as text.
 */
const SINGLE_LINE_PATTERN = /^\P{Cc}*$/u;

/**
 * The same rule, widened by the three whitespace controls that make prose
 * prose: tab, line feed and carriage return.
 */
const MULTILINE_PATTERN = /^[\P{Cc}\t\n\r]*$/u;

/**
 * Message both patterns report. It names the cause rather than echoing the
 * offending value, which would put the rejected bytes into the response.
 */
const CONTROL_CHARACTER_MESSAGE =
  '$property must not contain control characters';

/**
 * Free-text field of a request body: a length bound plus a rejection of the
 * control characters that have no business in one.
 *
 * The load-bearing character is `U+0000`. JSON admits it inside a string and
 * `@IsString()`/`@MaxLength()` both accept it, but PostgreSQL cannot store a
 * NUL in a `text` column and fails the statement with SQLSTATE `22021` — so
 * a one-character request body turned a tasting note into a `500` and a
 * logged server error. The rest of the control range is rejected with it
 * because no field this decorator guards has a use for a vertical tab or a
 * bell, and because a control character that survives into a log line, a CSV
 * export or a terminal is a way to forge structure there.
 *
 * @param options - Length bound and the three shape switches; see
 *   {@link SafeTextOptions}.
 * @returns A property decorator validating the field.
 */
export const SafeText = (options: SafeTextOptions): PropertyDecorator =>
  applyDecorators(
    ...options.optional ? [IsOptional()] : [],
    IsString(),
    ...options.notEmpty ? [IsNotEmpty()] : [],
    MaxLength(options.max),
    Matches(
      options.multiline ? MULTILINE_PATTERN : SINGLE_LINE_PATTERN,
      { message: CONTROL_CHARACTER_MESSAGE },
    ),
  );
