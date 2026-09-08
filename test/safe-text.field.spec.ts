import 'reflect-metadata';

import { validate } from 'class-validator';

import { SafeText } from '~decorators/fields';

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const NEL = String.fromCharCode(0x85);

class Prose {
  @SafeText({ max: 20, optional: true, multiline: true })
  public value?: string;
}

class OneLine {
  @SafeText({ max: 20, optional: true })
  public value?: string;
}

class ShopName {
  @SafeText({ max: 20, optional: true, notEmpty: true })
  public value?: string;
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
  const instance = Object.assign(new type(), { value });
  const errors = await validate(instance);

  return errors.length === 0;
}

describe('SafeText — the NUL byte', () => {
  /**
   * The defect this closes: `@IsString()` and `@MaxLength()` both accept a
   * NUL, and PostgreSQL then rejects the statement with SQLSTATE `22021`
   * ("invalid byte sequence for encoding UTF8: 0x00"), so a one-character
   * request body answered `500` and logged a server error.
   */
  it('rejects a NUL in a prose field', async () => {
    await expect(accepts(Prose, `note${NUL}`)).resolves.toBe(false);
  });

  it('rejects a NUL in a single-line field', async () => {
    await expect(accepts(OneLine, `shop${NUL}`)).resolves.toBe(false);
  });
});

describe('SafeText — multiline', () => {
  it('accepts prose with newlines and tabs', async () => {
    await expect(accepts(Prose, 'peat\nsmoke\tsalt')).resolves.toBe(true);
  });

  it('accepts a carriage return', async () => {
    await expect(accepts(Prose, 'a\r\nb')).resolves.toBe(true);
  });

  it('accepts non-Latin prose and emoji', async () => {
    await expect(accepts(Prose, 'смак торфу 🥃')).resolves.toBe(true);
  });

  it('accepts the empty string, which is how a note clears', async () => {
    await expect(accepts(Prose, '')).resolves.toBe(true);
  });

  it('rejects another C0 control', async () => {
    await expect(accepts(Prose, `a${BELL}b`)).resolves.toBe(false);
  });

  it('rejects a C1 control', async () => {
    await expect(accepts(Prose, `a${NEL}b`)).resolves.toBe(false);
  });

  it('rejects a value past the length bound', async () => {
    await expect(accepts(Prose, 'x'.repeat(21))).resolves.toBe(false);
  });
});

describe('SafeText — single line', () => {
  it('accepts a plain shop name', async () => {
    await expect(accepts(OneLine, 'Duty Free')).resolves.toBe(true);
  });

  /**
   * A newline in a one-line field is not content: it is a way to forge a
   * second line wherever the value is rendered as text.
   */
  it('rejects a newline', async () => {
    await expect(accepts(OneLine, 'shop\nWARN forged')).resolves.toBe(false);
  });

  it('rejects a tab', async () => {
    await expect(accepts(OneLine, 'a\tb')).resolves.toBe(false);
  });
});

describe('SafeText — notEmpty', () => {
  it('rejects the empty string when it must name something', async () => {
    await expect(accepts(ShopName, '')).resolves.toBe(false);
  });

  it('accepts an absent optional field', async () => {
    const errors = await validate(new ShopName());

    expect(errors).toHaveLength(0);
  });

  it('rejects a non-string', async () => {
    await expect(accepts(ShopName, 42)).resolves.toBe(false);
  });
});
