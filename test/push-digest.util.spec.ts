import {
  PUSH_DIGEST_MAX_ITEMS,
  PUSH_DROPS_URL,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_TITLE_ONE,
} from '~constants';
import type { ID, PushDigestItem, PushDropRow } from '~types';
import { PushDigestUtils } from '~utils';

/**
 * Builds a claimed drop with sane defaults, overridable per test.
 *
 * @param overrides - Fields to replace.
 * @returns The drop row.
 */
function drop(overrides: Partial<PushDropRow>): PushDropRow {
  return {
    userId: 'user-1' as ID,
    productId: 'product-1' as ID,
    storeProductId: 'offer-1' as ID,
    name: 'Ardbeg',
    nameOrig: 'Віскі Ardbeg 10 років 0.7л',
    age: 10,
    storeName: 'rozetka',
    price: 880,
    previousPrice: 1000,
    currency: 'UAH',
    discountPct: 12,
    ...overrides,
  };
}

describe('PushDigestUtils.byUser', () => {
  it('partitions rows by user, keeping their order', () => {
    const rows = [
      drop({ userId: 'user-1' as ID, storeProductId: 'offer-1' as ID }),
      drop({ userId: 'user-2' as ID, storeProductId: 'offer-2' as ID }),
      drop({ userId: 'user-1' as ID, storeProductId: 'offer-3' as ID }),
    ];

    const users = PushDigestUtils.byUser(rows);

    expect([...users.keys()]).toEqual(['user-1', 'user-2']);
    expect(users.get('user-1' as ID)?.map((row) => row.storeProductId))
      .toEqual(['offer-1', 'offer-3']);
    expect(users.get('user-2' as ID)).toHaveLength(1);
  });
});

describe('PushDigestUtils.bestPerProduct', () => {
  it('keeps the largest discount per bottling and counts its stores', () => {
    const rows = [
      drop({ storeProductId: 'offer-1' as ID, discountPct: 8 }),
      drop({
        storeProductId: 'offer-2' as ID,
        storeName: 'silpo',
        discountPct: 15,
      }),
      drop({
        storeProductId: 'offer-3' as ID,
        storeName: 'silpo',
        discountPct: 3,
      }),
    ];

    const items = PushDigestUtils.bestPerProduct(rows);

    expect(items).toHaveLength(1);
    expect(items[0].discountPct).toBe(15);
    expect(items[0].storeCount).toBe(2);
  });

  it('sorts bottlings by discount descending, then by name', () => {
    const rows = [
      drop({ productId: 'product-1' as ID, name: 'Bowmore', discountPct: 5 }),
      drop({ productId: 'product-2' as ID, name: 'Ardbeg', discountPct: 20 }),
      drop({ productId: 'product-3' as ID, name: 'Arran', discountPct: 5 }),
    ];

    const items = PushDigestUtils.bestPerProduct(rows);

    expect(items.map((item) => item.discountPct)).toEqual([20, 5, 5]);
    expect(items.map((item) => item.name))
      .toEqual(['Ardbeg 10yo', 'Arran 10yo', 'Bowmore 10yo']);
  });

  it('appends the age to a canonical name and skips it for NAS', () => {
    const aged = PushDigestUtils.bestPerProduct([drop({})]);
    const nas = PushDigestUtils.bestPerProduct([drop({ age: null })]);

    expect(aged[0].name).toBe('Ardbeg 10yo');
    expect(nas[0].name).toBe('Ardbeg');
  });

  it('falls back to the raw name, which carries the age inline', () => {
    const items = PushDigestUtils.bestPerProduct([drop({ name: null })]);

    expect(items[0].name).toBe('Віскі Ardbeg 10 років 0.7л');
  });
});

describe('PushDigestUtils.payload', () => {
  /**
   * Builds a digest item with sane defaults.
   *
   * @param overrides - Fields to replace.
   * @returns The digest item.
   */
  function item(overrides: Partial<PushDigestItem>): PushDigestItem {
    return {
      productId: 'product-1' as ID,
      name: 'Ardbeg 10yo',
      discountPct: 12,
      storeCount: 1,
      ...overrides,
    };
  }

  it('links a single drop straight to its product', () => {
    const payload = PushDigestUtils.payload([item({})]);

    expect(payload.title).toBe(PUSH_TITLE_ONE);
    expect(payload.body).toBe('Ardbeg 10yo −12%');
    expect(payload.url).toBe('/product/product-1');
    expect(payload.count).toBe(1);
  });

  it('links several drops to the favorites drops report', () => {
    const payload = PushDigestUtils.payload([
      item({}),
      item({ productId: 'product-2' as ID, name: 'Arran', discountPct: 7 }),
    ]);

    expect(payload.title).toContain('2');
    expect(payload.body).toBe('Ardbeg 10yo −12%, Arran −7%');
    expect(payload.url).toBe(PUSH_DROPS_URL);
    expect(payload.count).toBe(2);
  });

  it('caps the named items and folds the rest into a tail', () => {
    const items = Array.from(
      { length: PUSH_DIGEST_MAX_ITEMS + 3 },
      (_, index) =>
        item({
          productId: `product-${index}` as ID,
          name: `Whisky ${index}`,
        }),
    );

    const payload = PushDigestUtils.payload(items);

    expect(payload.count).toBe(PUSH_DIGEST_MAX_ITEMS + 3);
    expect(payload.body).toContain('та ще 3');
    expect(payload.body.split(',')).toHaveLength(PUSH_DIGEST_MAX_ITEMS + 1);
  });

  it('trims named items until the payload fits the byte budget', () => {
    const huge = 'X'.repeat(1500);

    const items = Array.from({ length: 4 }, (_, index) =>
      item({
        productId: `product-${index}` as ID,
        name: `${huge} ${index}`,
      }));

    const payload = PushDigestUtils.payload(items);

    expect(Buffer.byteLength(JSON.stringify(payload)))
      .toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
    expect(payload.count).toBe(4);
    expect(payload.body).toContain('та ще');
  });
});
