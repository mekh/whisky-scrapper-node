import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  QUICK_FILTER_MAX_KEYS,
  QUICK_FILTER_MAX_VALUES_PER_KEY,
  QUICK_FILTER_PAYLOAD_MAX_BYTES,
  QUICK_FILTER_VALUE_MAX_LENGTH,
} from '~constants';
import { FilterPayload } from '~decorators/fields';
import type { QuickFilterPayload } from '~types';

class Holder {
  @FilterPayload()
  public filters!: QuickFilterPayload;
}

/**
 * Builds an instance without going through a constructor, the way the
 * `ValidationPipe` hands class-transformer output to the validator.
 *
 * @param filters - The payload to validate.
 * @returns The populated instance.
 */
function make(filters: unknown): Holder {
  return Object.assign(new Holder(), { filters });
}

describe('FilterPayload — accepted shapes', () => {
  it('accepts a realistic filter set', async () => {
    const errors = await validate(make({
      stores: ['silpo', 'goodwine'],
      countries: ['gb'],
      minPrice: 800,
      maxPrice: 2500,
      favoritesOnly: true,
      window: null,
    }));

    expect(errors).toHaveLength(0);
  });

  it('accepts an empty payload — "show everything" is a real set', async () => {
    const errors = await validate(make({}));

    expect(errors).toHaveLength(0);
  });

  it('accepts a dimension the backend has never heard of', async () => {
    /**
     * The load-bearing case for the whole feature: a client that ships a new
     * filter dimension must not be rejected by a backend deployed before it.
     */
    const errors = await validate(make({
      regions: ['islay', 'speyside'],
      peatMin: 3,
    }));

    expect(errors).toHaveLength(0);
  });
});

describe('FilterPayload — rejected shapes', () => {
  it.each([
    ['a nested object', { range: { min: 1, max: 2 } }],
    ['an array of arrays', { stores: [['silpo']] }],
    ['an array of objects', { stores: [{ slug: 'silpo' }] }],
    ['an array payload', ['silpo']],
    ['a scalar payload', 'silpo'],
    ['NaN', { minPrice: Number.NaN }],
    ['an empty key', { '': 1 }],
  ])('rejects %s', async (_label, filters) => {
    const errors = await validate(make(filters));

    expect(errors).toHaveLength(1);
  });

  it('rejects more keys than the cap allows', async () => {
    const filters = Object.fromEntries(
      Array.from({ length: QUICK_FILTER_MAX_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
    );

    const errors = await validate(make(filters));

    expect(errors).toHaveLength(1);
  });

  it('rejects an array longer than the element cap', async () => {
    const stores = Array.from(
      { length: QUICK_FILTER_MAX_VALUES_PER_KEY + 1 },
      (_, i) => `s${i}`,
    );

    const errors = await validate(make({ stores }));

    expect(errors).toHaveLength(1);
  });

  it('rejects an overlong string value', async () => {
    const errors = await validate(make({
      name: 'x'.repeat(QUICK_FILTER_VALUE_MAX_LENGTH + 1),
    }));

    expect(errors).toHaveLength(1);
  });

  it('rejects a payload past the byte budget', async () => {
    const filters = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `k${i}`,
        Array.from({ length: 40 }, (_, j) => `value-${i}-${j}-padding`),
      ]),
    );

    expect(Buffer.byteLength(JSON.stringify(filters)))
      .toBeGreaterThan(QUICK_FILTER_PAYLOAD_MAX_BYTES);

    const errors = await validate(make(filters));

    expect(errors).toHaveLength(1);
  });
});

describe('FilterPayload — transformation', () => {
  it('survives plainToInstance byte-identical', async () => {
    /**
     * `filters` is deliberately a leaf property: were it a nested typed class,
     * the global pipe's `whitelist` (incoming) and the `ValidationInterceptor`
     * (outgoing) would both strip the keys this backend does not declare —
     * silently destroying a newer client's saved filters.
     */
    const filters = {
      stores: ['silpo'],
      regions: ['islay'],
      peatMin: 3,
      favoritesOnly: false,
    };

    const instance = plainToInstance(Holder, { filters }, {
      exposeUnsetFields: false,
    });

    const errors = await validate(instance, { whitelist: true });

    expect(errors).toHaveLength(0);
    expect(instance.filters).toEqual(filters);
  });
});
