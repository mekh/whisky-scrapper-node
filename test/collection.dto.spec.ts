import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ValidationConfig } from '~config';
import {
  COLLECTION_PRICE_MAX,
  COLLECTION_PURCHASES_MAX_PER_REQUEST,
} from '~constants';
import {
  CollectionCreateDto,
  CollectionUpdateDto,
} from '~domain/collection/dto';
import type { ID } from '~types';

const NUL = String.fromCharCode(0);

const PRODUCT_ID = '019ff1bf-5e59-7d17-b699-b4ea1c8183ab' as ID;

const PURCHASE_ID = '019ff1bf-5e59-7d17-b699-b4ea1c8183ac' as ID;

/**
 * Validates a payload exactly as the global pipe does — same transformer
 * options, same validator options — so a test cannot pass on settings
 * production does not use.
 *
 * @param type - The DTO class to validate against.
 * @param payload - The raw request body.
 * @returns The flattened validation message, empty when the body is valid.
 */
async function check<T extends object>(
  type: new() => T,
  payload: unknown,
): Promise<string> {
  const instance = plainToInstance(type, payload, {
    exposeUnsetFields: false,
  });

  const errors = await validate(instance, ValidationConfig.validatorOptions);

  return ValidationConfig.parseValidationErrors(errors);
}

/**
 * Builds a `purchases.add` array of the given length out of the smallest
 * valid entry there is.
 *
 * Every field of a purchase is optional, so `{}` is a legitimate addition
 * three bytes long — which is exactly what made an uncapped array able to
 * buy hundreds of thousands of inserts from one request body.
 *
 * @param count - How many entries to build.
 * @returns The array.
 */
function additions(count: number): object[] {
  return Array.from({ length: count }, () => ({}));
}

describe('CollectionUpdateDto — purchase group caps', () => {
  it('accepts the largest allowed group', async () => {
    const message = await check(CollectionUpdateDto, {
      purchases: { add: additions(COLLECTION_PURCHASES_MAX_PER_REQUEST) },
    });

    expect(message).toBe('');
  });

  it('rejects one entry past the cap', async () => {
    const message = await check(CollectionUpdateDto, {
      purchases: { add: additions(COLLECTION_PURCHASES_MAX_PER_REQUEST + 1) },
    });

    expect(message).toContain('add');
  });

  it('caps the update group too', async () => {
    const update = Array.from(
      { length: COLLECTION_PURCHASES_MAX_PER_REQUEST + 1 },
      () => ({ id: PURCHASE_ID }),
    );

    const message = await check(CollectionUpdateDto, {
      purchases: { update },
    });

    expect(message).toContain('update');
  });

  it('caps the remove group too', async () => {
    const remove = Array.from(
      { length: COLLECTION_PURCHASES_MAX_PER_REQUEST + 1 },
      () => PURCHASE_ID,
    );

    const message = await check(CollectionUpdateDto, {
      purchases: { remove },
    });

    expect(message).toContain('remove');
  });

  it('still accepts a body with no purchases block at all', async () => {
    const message = await check(CollectionUpdateDto, { rating: 7.5 });

    expect(message).toBe('');
  });
});

describe('CollectionUpdateDto — purchase price bound', () => {
  it('accepts the ceiling', async () => {
    const message = await check(CollectionUpdateDto, {
      purchases: { add: [{ price: COLLECTION_PRICE_MAX }] },
    });

    expect(message).toBe('');
  });

  /**
   * `@IsNumber({ maxDecimalPlaces })` only inspects values with a
   * fractional part, so `1e11` and `1e21` passed it as integers and then
   * overflowed `numeric(12,2)` in Postgres (SQLSTATE `22003`) as a `500`.
   */
  it.each([COLLECTION_PRICE_MAX + 1, 1e11, 1e21])(
    'rejects %p',
    async (price) => {
      const message = await check(CollectionUpdateDto, {
        purchases: { add: [{ price }] },
      });

      expect(message).toContain('price');
    },
  );

  it('rejects a negative price', async () => {
    const message = await check(CollectionUpdateDto, {
      purchases: { add: [{ price: -1 }] },
    });

    expect(message).toContain('price');
  });
});

describe('CollectionCreateDto — control characters', () => {
  it.each(['notes', 'nose', 'palate', 'finish'])(
    'rejects a NUL in %s',
    async (field) => {
      const message = await check(CollectionCreateDto, {
        productId: PRODUCT_ID,
        [field]: `tastes of${NUL}`,
      });

      expect(message).toContain('control characters');
    },
  );

  it('accepts a multi-line tasting note', async () => {
    const message = await check(CollectionCreateDto, {
      productId: PRODUCT_ID,
      notes: 'Ніс: торф.\nСмак: сіль.',
    });

    expect(message).toBe('');
  });

  it('rejects a newline in a free-text shop name', async () => {
    const message = await check(CollectionCreateDto, {
      productId: PRODUCT_ID,
      purchase: { storeName: 'Duty Free\nforged' },
    });

    expect(message).toContain('control characters');
  });

  it('rejects an impossible purchase date', async () => {
    const message = await check(CollectionCreateDto, {
      productId: PRODUCT_ID,
      purchase: { purchasedOn: '2026-02-30' },
    });

    expect(message).toContain('purchasedOn');
  });
});
