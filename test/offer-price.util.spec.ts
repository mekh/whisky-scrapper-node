import { OfferPriceUtils } from '~utils';

import type { ReportCurrentRow } from '~types';

/**
 * Builds the offer-shaped subset the comparator reads.
 *
 * @param over - Fields to override.
 * @returns An offer with an id, a price and a store name.
 */
function makeOffer(
  over: Partial<Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>> = {},
): Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'> {
  return {
    id: 'a',
    price: 1000,
    storeName: 'Silpo',
    ...over,
  } as Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>;
}

describe('OfferPriceUtils.previousDrop', () => {
  it('reports the previous price when the price has fallen', () => {
    expect(OfferPriceUtils.previousDrop({ price: 900, previousPrice: 1000 }))
      .toBe(1000);
  });

  it('reports nothing when the price rose or held', () => {
    expect(OfferPriceUtils.previousDrop({ price: 1100, previousPrice: 1000 }))
      .toBeNull();
    expect(OfferPriceUtils.previousDrop({ price: 1000, previousPrice: 1000 }))
      .toBeNull();
  });

  it('reports nothing for an offer with no earlier snapshot', () => {
    expect(OfferPriceUtils.previousDrop({ price: 900, previousPrice: null }))
      .toBeNull();
  });
});

describe('OfferPriceUtils.discountPct', () => {
  it('rounds the drop to whole percent', () => {
    expect(OfferPriceUtils.discountPct(900, 1000)).toBe(10);
    expect(OfferPriceUtils.discountPct(1649, 1749)).toBe(6);
  });

  it('answers null without a reference, or when nothing was saved', () => {
    expect(OfferPriceUtils.discountPct(900, null)).toBeNull();
    expect(OfferPriceUtils.discountPct(1000, 1000)).toBeNull();
    expect(OfferPriceUtils.discountPct(1100, 1000)).toBeNull();
  });

  it('refuses a non-positive reference rather than dividing by it', () => {
    expect(OfferPriceUtils.discountPct(900, 0)).toBeNull();
    expect(OfferPriceUtils.discountPct(900, -100)).toBeNull();
  });
});

describe('OfferPriceUtils.byPrice', () => {
  it('orders by price first', () => {
    const cheap = makeOffer({ id: 'z', price: 900, storeName: 'Zakaz' });
    const dear = makeOffer({ id: 'a', price: 1000, storeName: 'Alco' });

    expect([dear, cheap].sort((a, b) => OfferPriceUtils.byPrice(a, b))).toEqual(
      [cheap, dear],
    );
  });

  it('breaks a price tie on the store name, then on the id', () => {
    const first = makeOffer({ id: 'b', storeName: 'Alco' });
    const second = makeOffer({ id: 'a', storeName: 'Zakaz' });

    expect([second, first].sort((a, b) => OfferPriceUtils.byPrice(a, b)))
      .toEqual([first, second]);

    const sameStoreA = makeOffer({ id: 'a' });
    const sameStoreB = makeOffer({ id: 'b' });

    expect(
      [sameStoreB, sameStoreA].sort((a, b) => OfferPriceUtils.byPrice(a, b)),
    )
      .toEqual([sameStoreA, sameStoreB]);
  });

  it('is deterministic, so paging cannot duplicate or drop an offer', () => {
    const offers = [
      makeOffer({ id: 'c', price: 1000, storeName: 'Silpo' }),
      makeOffer({ id: 'a', price: 1000, storeName: 'Silpo' }),
      makeOffer({ id: 'b', price: 1000, storeName: 'Silpo' }),
    ];

    const once = [...offers].sort((a, b) => OfferPriceUtils.byPrice(a, b)).map((
      o,
    ) => o.id);
    const twice = [...offers].reverse().sort((a, b) =>
      OfferPriceUtils.byPrice(a, b)
    )
      .map((o) => o.id);

    expect(once).toEqual(twice);
  });
});
