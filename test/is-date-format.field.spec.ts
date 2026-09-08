import 'reflect-metadata';

import { validate } from 'class-validator';

import { IsDateFormat, IsoDate, IsoMonth } from '~decorators/fields';

class Day {
  @IsDateFormat('YYYY-MM-DD')
  public value!: string;
}

class Compact {
  @IsDateFormat('YYYYMMDD')
  public value!: string;
}

class Stamp {
  @IsDateFormat('YYYYMMDDHHMMSS')
  public value!: string;
}

class Month {
  @IsDateFormat('YYYY-MM')
  public value!: string;
}

class PurchaseDay {
  @IsoDate(true)
  public value?: string;
}

class RangeMonth {
  @IsoMonth(true)
  public value?: string;
}

/**
 * Builds an instance without going through a constructor, the way the
 * `ValidationPipe` hands class-transformer output to the validator.
 *
 * @param type - The class to instantiate.
 * @param value - The value to validate.
 * @returns The populated instance.
 */
function make<T extends { value?: unknown }>(
  type: new() => T,
  value: unknown,
): T {
  return Object.assign(new type(), { value });
}

/**
 * Validates one value against one decorated class.
 *
 * @param type - The class carrying the decorator under test.
 * @param value - The value to validate.
 * @returns True when the value passed validation.
 */
async function accepts<T extends { value?: unknown }>(
  type: new() => T,
  value: unknown,
): Promise<boolean> {
  const errors = await validate(make(type, value));

  return errors.length === 0;
}

describe('IsDateFormat — YYYY-MM-DD', () => {
  it('accepts a real day', async () => {
    await expect(accepts(Day, '2026-09-08')).resolves.toBe(true);
  });

  it('accepts a leap day in a leap year', async () => {
    await expect(accepts(Day, '2024-02-29')).resolves.toBe(true);
  });

  it('rejects a leap day outside one', async () => {
    await expect(accepts(Day, '2026-02-29')).resolves.toBe(false);
  });

  /**
   * The reason the decorator exists. A shape-only check accepted these, so
   * they reached Postgres as a `date` and failed there with SQLSTATE `22008`
   * — a `500` for what is a malformed request.
   */
  it.each([
    '2026-99-99',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '0000-01-01',
  ])('rejects the impossible day %s', async (value) => {
    await expect(accepts(Day, value)).resolves.toBe(false);
  });

  it.each([
    '2026-9-8',
    '2026/09/08',
    '2026-09-08T00:00:00Z',
    '20260908',
    '',
  ])('rejects the misspelled day %s', async (value) => {
    await expect(accepts(Day, value)).resolves.toBe(false);
  });

  it.each([42, null, undefined, {}, ['2026-09-08']])(
    'rejects the non-string %p',
    async (value) => {
      await expect(accepts(Day, value)).resolves.toBe(false);
    },
  );
});

describe('IsDateFormat — the other formats', () => {
  it('accepts a compact day', async () => {
    await expect(accepts(Compact, '20260908')).resolves.toBe(true);
  });

  it('rejects a compact impossible day', async () => {
    await expect(accepts(Compact, '20260230')).resolves.toBe(false);
  });

  it('accepts a full stamp', async () => {
    await expect(accepts(Stamp, '20260908235959')).resolves.toBe(true);
  });

  it('rejects a stamp with a 25th hour', async () => {
    await expect(accepts(Stamp, '20260908250000')).resolves.toBe(false);
  });

  it('rejects a stamp with a 60th second', async () => {
    await expect(accepts(Stamp, '20260908235960')).resolves.toBe(false);
  });

  it('accepts a real month', async () => {
    await expect(accepts(Month, '2026-09')).resolves.toBe(true);
  });

  it.each(['2026-13', '2026-00', '2026-9'])(
    'rejects the month %s',
    async (value) => {
      await expect(accepts(Month, value)).resolves.toBe(false);
    },
  );
});

describe('the composites built on it', () => {
  it('IsoDate accepts an absent optional day', async () => {
    const errors = await validate(new PurchaseDay());

    expect(errors).toHaveLength(0);
  });

  it('IsoDate rejects an impossible day', async () => {
    await expect(accepts(PurchaseDay, '2026-99-99')).resolves.toBe(false);
  });

  it('IsoMonth accepts an absent optional month', async () => {
    const errors = await validate(new RangeMonth());

    expect(errors).toHaveLength(0);
  });

  it('IsoMonth rejects a year Postgres has no date for', async () => {
    await expect(accepts(RangeMonth, '0000-01')).resolves.toBe(false);
  });
});
