import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

import type { DateFormat } from '~types';

/**
 * The pattern each supported format is read with. Every group is a calendar
 * component, in the order {@link calendarParts} expects them, so extending
 * the decorator with a new format is one entry here plus one member of
 * {@link DateFormat}.
 *
 * The map is typed `Record<DateFormat, RegExp>`, which is what makes the
 * lookup in {@link matchesFormat} total: no caller can name a format the
 * table does not hold.
 */
const FORMAT_PATTERNS: Record<DateFormat, RegExp> = {
  YYYYMMDDHHMMSS: /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
  YYYYMMDD: /^(\d{4})(\d{2})(\d{2})$/,
  'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
  'YYYY-MM': /^(\d{4})-(\d{2})$/,
};

/**
 * Reports whether the calendar components describe a day that exists.
 *
 * The components are fed to `Date.UTC` and read back out: a value the
 * calendar has to normalize (a 30th of February, a 13th month, a 25th hour)
 * comes back as a different day, which is the whole test. A format that
 * states no day or time defaults to the first of the month at midnight, so
 * `YYYY-MM` is checked exactly as far as it claims.
 *
 * Years below 100 are rejected as a side effect, since `Date.UTC` maps them
 * into the 1900s and the read-back then disagrees. That is the desired
 * answer here: Postgres has no year 0, and no field in this API describes
 * the first century.
 *
 * @param parts - Year, month, and optionally day, hour, minute and second.
 * @returns True when the components name a real instant.
 */
const isRealDate = (parts: number[]): boolean => {
  const [
    year,
    month,
    day = 1,
    hour = 0,
    minute = 0,
    second = 0,
  ] = parts;

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
};

/**
 * Reports whether a value is a string in the given format naming a real
 * date.
 *
 * @param format - The format to read the value with.
 * @param value - The value under validation, of unknown type.
 * @returns True when the value parses and the date exists.
 */
const matchesFormat = (format: DateFormat, value: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const match = FORMAT_PATTERNS[format].exec(value);

  if (!match) {
    return false;
  }

  return isRealDate(match.slice(1).map(Number));
};

/**
 * Validates that a field holds a bare calendar value in one exact format,
 * naming a date that exists.
 *
 * Deliberately stricter than a shape check: a regex alone accepts
 * `2026-99-99` and `2026-02-30`, which pass validation, reach Postgres as a
 * `date` and fail there with SQLSTATE `22008` — a `500` for what is a
 * malformed request. Deliberately stricter than `@IsDateString()` too, which
 * accepts any ISO-8601 value, including a timestamp whose calendar day
 * depends on the timezone it is read in.
 *
 * @param format - The format the value must be spelled in.
 * @param options - Standard class-validator options.
 * @returns A property decorator validating the field's format.
 */
export const IsDateFormat = (
  format: DateFormat,
  options?: ValidationOptions,
): PropertyDecorator =>
  ValidateBy(
    {
      name: `isDateFormat-${format}`,
      validator: {
        validate: (value: unknown): boolean => matchesFormat(format, value),
        defaultMessage: buildMessage(
          (eachPrefix): string =>
            `${eachPrefix}$property must be a valid ${format} date`,
          options,
        ),
      },
    },
    options,
  );
