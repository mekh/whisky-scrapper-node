import 'reflect-metadata';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';

import type { ProductSnapshot } from '~types';

const n = new NormalizeService();

function snap(
  name: string,
  over: Partial<ProductSnapshot> = {},
): ProductSnapshot {
  return {
    storeSlug: 't',
    storeSku: '1',
    url: '',
    name,
    price: 1,
    brand: null,
    oldPrice: null,
    currency: 'UAH',
    inStock: true,
    promo: false,
    volumeMl: null,
    abv: null,
    ageYears: null,
    whiskyType: null,
    country: null,
    flavorTags: [],
    rawAttrs: {},
    factSources: {},
    ...over,
  };
}

describe('NormalizeService.extractVolumeMl', () => {
  it('reads litres and millilitres', () => {
    expect(n.extractVolumeMl('Віскі Jameson 0,7л')).toBe(700);
    expect(n.extractVolumeMl('Whisky 700 мл')).toBe(700);
    expect(n.extractVolumeMl('Bottle 1 л')).toBe(1000);
    expect(n.extractVolumeMl("без об'єму")).toBeNull();
  });
});

describe('NormalizeService.extractAbv', () => {
  it('reads ABV and ignores discounts', () => {
    expect(n.extractAbv("Jack Daniel's 40% 1л")).toBe(40);
    expect(n.extractAbv('cask strength 58,5%')).toBe(58.5);
    expect(n.extractAbv('акція -25%')).toBeNull();
  });

  it('reads an ABV that starts the text', () => {
    // A detail page's characteristics field is often the bare value.
    expect(n.extractAbv('40%')).toBe(40);
    expect(n.extractAbv('43,5 %')).toBe(43.5);
    expect(n.extractAbv('40% 0,7л')).toBe(40);
  });

  it('still skips a discount that starts the text', () => {
    expect(n.extractAbv('-25% Jameson')).toBeNull();
  });
});

describe('NormalizeService.canonicalCountry', () => {
  it('drops umbrella names and keeps concrete ones', () => {
    expect(n.canonicalCountry('Великобританія')).toBeNull();
    expect(n.canonicalCountry('Велика Британія')).toBeNull();
    expect(n.canonicalCountry('Шотландія')).toBe('Шотландія');
    expect(n.canonicalCountry('  Ірландія ')).toBe('Ірландія');
    expect(n.canonicalCountry(null)).toBeNull();
    expect(n.canonicalCountry('')).toBeNull();
  });
});

describe('NormalizeService.parseAbvValue', () => {
  it('parses field values with or without a percent sign', () => {
    expect(n.parseAbvValue('40')).toBe(40);
    expect(n.parseAbvValue('40%')).toBe(40);
    expect(n.parseAbvValue('46')).toBe(46);
    expect(n.parseAbvValue('37-43%')).toBe(37);
    expect(n.parseAbvValue('-25%')).toBeNull();
    expect(n.parseAbvValue(null)).toBeNull();
  });
});

describe('NormalizeService.parseVolumeValue', () => {
  it('treats a bare number as litres', () => {
    expect(n.parseVolumeValue('700 мл')).toBe(700);
    expect(n.parseVolumeValue('0,7 л')).toBe(700);
    expect(n.parseVolumeValue('0.7')).toBe(700);
    expect(n.parseVolumeValue('1')).toBe(1000);
    expect(n.parseVolumeValue(null)).toBeNull();
  });
});

describe('NormalizeService.parseAgeValue', () => {
  it('reads a bare field value as years, in the whisky range', () => {
    expect(n.parseAgeValue('12')).toBe(12);
    expect(n.parseAgeValue(' 18 ')).toBe(18);
    expect(n.parseAgeValue('12 років')).toBe(12);
    expect(n.parseAgeValue('120')).toBeNull();
    expect(n.parseAgeValue('0')).toBeNull();
    expect(n.parseAgeValue('')).toBeNull();
    expect(n.parseAgeValue(null)).toBeNull();
  });
});

describe('NormalizeService.extractAgeYears', () => {
  it('reads an explicit age and rejects out-of-range values', () => {
    expect(n.extractAgeYears('Aberlour 12 років')).toBe(12);
    expect(n.extractAgeYears('Glenfiddich 18 yo')).toBe(18);
    expect(n.extractAgeYears('Macallan aged 25 years')).toBe(25);
    expect(n.extractAgeYears('без витримки')).toBeNull();
    expect(n.extractAgeYears('відомий понад 250 років')).toBeNull();
    expect(n.extractAgeYears('понад 225 років ремесла')).toBeNull();
    expect(n.extractAgeYears('витримка 120 років')).toBeNull();
  });

  it('reads the Russian spelling a few listings use', () => {
    expect(n.extractAgeYears('Hart Brothers Dalmore 11 лет')).toBe(11);
    expect(n.extractAgeYears('Miltonduff Vintage 1990 21 год')).toBe(21);
  });

  /**
   * The spelling that collapsed a whole expression onto one bottling.
   *
   * `ProductNameUtils` deletes `12уо` from the display name, so before this
   * pattern matched it the age was erased from the name and recorded nowhere:
   * the key came out `dalmore|v700|a0` for the 12, 15, 18 and 30 year old
   * alike, and all four were served as `Dalmore 12yo`.
   */
  it('reads the Cyrillic transliteration of "yo"', () => {
    expect(n.extractAgeYears('Віскі Dalmore 12уо 0.7 л 40%')).toBe(12);
    expect(n.extractAgeYears('Віскі The Dalmore 30 уо 43.8% 0.7 л')).toBe(30);
    expect(n.extractAgeYears('Віскі Arran 10УО 0.05 л 46%')).toBe(10);
    expect(n.extractAgeYears('Віскі West Cork Bourbon Cask 3 уо')).toBe(3);
  });

  /**
   * The stripper folds a stray look-alike letter before it matches, so the
   * reader has to as well or the age is deleted from the name and stored
   * nowhere.
   */
  it('reads through a look-alike letter of the other alphabet', () => {
    expect(n.extractAgeYears('Вiскi Chivas Regal 12 рокiв')).toBe(12);
    expect(n.extractAgeYears('Вiскi «Хайленд Парк» 18 рокiв')).toBe(18);
  });

  /**
   * The guards the wider pattern must not cost: a vintage is not an age, and
   * a number that merely precedes a word is not one either.
   */
  it('still refuses a vintage and a bare number', () => {
    expect(n.extractAgeYears('Islay Barley Bruichladdich 2013 рік')).toBeNull();
    expect(n.extractAgeYears('Віскі Vat 69 1л')).toBeNull();
    expect(n.extractAgeYears('Wild Turkey 101 Proof 0.7 л')).toBeNull();
  });
});

describe('NormalizeService.normalize age handling', () => {
  it('ignores an age in the description, keeps one in the name', () => {
    const nas = snap('Віскі Hankey Bannister Original 40% 0,7л', {
      rawAttrs: { description: 'бленд, відомий у суспільстві понад 250 років' },
    });

    n.normalize(nas);

    expect(nas.ageYears).toBeNull();

    const turkey = snap('Віскі Wild Turkey 101 бурбон 50,5% 0,7л', {
      rawAttrs: { description: 'Понад 60 років Wild Turkey у серці Кентуккі' },
    });

    n.normalize(turkey);

    expect(turkey.ageYears).toBeNull();

    const aged = n.normalize(snap('Віскі Aberfeldy 12 років 40% 0,7л'));

    expect(aged.ageYears).toBe(12);
  });
});

describe('NormalizeService.matchKey', () => {
  /**
   * The end-to-end shape of the reported defect: with the Cyrillic `уо`
   * unread, every Dalmore in a 0.7 l bottle signed `dalmore|v700|a0`, so one
   * `product` row carried the 12, 15, 18 and 30 year old and the catalogue
   * showed the half-million-hryvnia 30 as `Dalmore 12yo 43% 0,7л`.
   */
  it('gives each age of one expression its own key', () => {
    const keys = [
      'Віскі Dalmore 12уо 0.7 л 40% у подарунковій коробці',
      'Віскі Dalmore 15уо 0.7 л 40% у подарунковій коробці',
      'Віскі Dalmore 18уо 0.7 л 43% у подарунковій коробці',
      'Віскі Dalmore 30уо 0.7 л 43.8% у подарунковій коробці',
    ].map((name) => n.matchKey(snap(name, { brand: 'Dalmore' })));

    expect(keys).toEqual([
      'dalmore|v700|a12',
      'dalmore|v700|a15',
      'dalmore|v700|a18',
      'dalmore|v700|a30',
    ]);
  });

  it('keeps two stores spelling one age on the same key', () => {
    const latin = n.matchKey(
      snap('Віскі Dalmore 18 yo 0.7 л 43%', { brand: 'Dalmore' }),
    );
    const cyrillic = n.matchKey(
      snap('Віскі Dalmore 18уо 0.7 л 43%', { brand: 'Dalmore' }),
    );

    expect(cyrillic).toBe(latin);
  });
});

describe('NormalizeService.extractFlavorTags', () => {
  it('matches flavor keywords', () => {
    expect(n.extractFlavorTags('Macallan sherry oak')).toContain('sherry');
    expect(n.extractFlavorTags('звичайний бленд')).toEqual([]);
  });

  /**
   * The inversion that makes the knowledge base the only source of peat.
   *
   * This used to assert the opposite. A shop's prose saying "торф'яний дим" is
   * marketing copy about one listing, and letting it write `peated` meant the
   * next sync re-derived the very tag the reconciliation pass had corrected.
   * The peat words still decide the level — through `flavor_rule`, where the
   * decision is reviewable and a negation can outrank a house profile.
   */
  it('never derives a peat tag from a listing', () => {
    expect(n.extractFlavorTags("Laphroaig торф'яний дим")).toEqual([]);
    expect(n.extractFlavorTags('Ardbeg peated smoky')).toEqual([]);
  });
});

describe('NormalizeService.normalize', () => {
  it('fills volume/abv/age from the name', () => {
    const s = n.normalize(snap('Віскі Aberlour 12 років 40% 0.7л'));

    expect(s.volumeMl).toBe(700);
    expect(s.abv).toBe(40);
    expect(s.ageYears).toBe(12);
  });

  it('fills country and type from a known brand', () => {
    const s = n.normalize(snap('Glenfarclas 12 0.7л'));

    expect(s.country).toBe('Шотландія');
    expect(s.whiskyType).toBe('single malt');
  });

  it('reads flavor and abv from rawAttrs', () => {
    const s = snap('Mystery whisky', {
      rawAttrs: { description: 'Хересна бочка, 46%' },
    });

    n.normalize(s);

    expect(s.flavorTags).toContain('sherry');
    expect(s.abv).toBe(46);
  });

  /**
   * The description is still read — it is where the other thirteen tags come
   * from — but its peat words no longer reach `flavorTags`.
   */
  it('reads a description without letting it state peat', () => {
    const s = snap('Mystery whisky', {
      rawAttrs: { description: "Островний торф'яний смак, 46%" },
    });

    n.normalize(s);

    expect(s.flavorTags).toEqual([]);
    expect(s.abv).toBe(46);
  });

  it('canonicalizes the brand and drops a wrong Cyrillic trademark', () => {
    const tormore = n.normalize(
      snap('Віскі Tormore Legacy 0,7л', { brand: 'тормор' }),
    );

    expect(tormore.brand).toBe('Tormore');

    const balblair = n.normalize(snap('Whisky', { brand: 'balblair' }));

    expect(balblair.brand).toBe('Balblair');

    const grants = n.normalize(
      snap('Напій на основі віскі Grants Winter Desert 30% 0,7л', {
        brand: 'вінтер',
      }),
    );

    expect(grants.brand).toBeNull();
  });
});

describe('NormalizeService.extractType', () => {
  it('classifies the whisky type', () => {
    expect(n.extractType('Віскі односолодовий Tomatin 12 років'))
      .toBe('single malt');
    expect(n.extractType("Віскі купажований бленд Grant's")).toBe('blend');
    expect(n.extractType('Bourbon Jim Beam')).toBe('bourbon');
    expect(n.extractType('Звичайний напій')).toBeNull();
  });
});

describe('NormalizeService.extractCountry', () => {
  it('classifies the origin country', () => {
    expect(n.extractCountry('Single malt Scotch whisky')).toBe('Шотландія');
    expect(n.extractCountry('Irish whiskey Jameson')).toBe('Ірландія');
    expect(n.extractCountry('без країни')).toBeNull();
  });
});

describe('NormalizeService.detectBrandInfo', () => {
  it('infers country and type from a known brand', () => {
    expect(n.detectBrandInfo('Віскі Jameson 0,7л'))
      .toEqual({ country: 'Ірландія', type: null });
    expect(n.detectBrandInfo('Macallan 12 Sherry Oak'))
      .toEqual({ country: 'Шотландія', type: 'single malt' });
    expect(n.detectBrandInfo('Jim Beam White 0.7л'))
      .toEqual({ country: 'США', type: 'bourbon' });
    expect(n.detectBrandInfo("Jack Daniel's Old No.7"))
      .toEqual({ country: 'США', type: 'tennessee' });
    expect(n.detectBrandInfo('Якийсь невідомий напій'))
      .toEqual({ country: null, type: null });
  });
});

describe('NormalizeService brand detection from the name', () => {
  const index = n.buildBrandIndex([
    'Highland',
    'Highland Park',
    "Jack Daniel's",
    'Arran',
    'Highland Park',
  ]);

  it('builds a deduplicated index, longest key first', () => {
    expect(index.map((entry) => entry.key)).toEqual([
      'highland park',
      'jack daniels',
      'highland',
      'arran',
    ]);
  });

  it('prefers the longest matching brand', () => {
    expect(n.detectBrandFromName('Віскі Highland Park 12yo 0,7л', index))
      .toBe('Highland Park');
  });

  it('matches across apostrophe spelling', () => {
    expect(n.detectBrandFromName('Jack Daniels Old No.7 40% 0,7л', index))
      .toBe("Jack Daniel's");
  });

  it('does not match a brand inside a longer word', () => {
    expect(n.detectBrandFromName('Whisky arrangement gift box', index))
      .toBeNull();
  });

  /**
   * The reported defect, end to end. `& Whisky` is goodwine's own category
   * label (`&wine` / `&whisky` / `&food` name its departments), left in the
   * `brand` table by a legacy import. `brandHaystack` deletes every
   * non-alphanumeric run, so it reduced to the bare key `whisky` — six
   * characters, one more than `umiki`, so the longest-key-first sort handed
   * `Віскі Umiki Whisky` a brand it has nothing to do with.
   *
   * Measured over the catalogue the same collision was suppressing the right
   * answer on 63 listings, `Jura`, `Arran`, `Nikka` and `Bell's` among them —
   * every real brand whose key is no longer than the word.
   */
  it('ignores a brand that is nothing but a category word', () => {
    const poisoned = n.buildBrandIndex(['& Whisky', 'Umiki', 'Jura']);

    expect(poisoned.map((entry) => entry.key)).toEqual(['umiki', 'jura']);

    expect(n.detectBrandFromName('Віскі Umiki Whisky', poisoned))
      .toBe('Umiki');
    expect(
      n.detectBrandFromName('Віскі Jura Seven Wood Scotch Whisky', poisoned),
    ).toBe('Jura');
  });

  /**
   * The guard must not cost a brand that merely contains a category word:
   * these are matched by their whole key, not by the word inside it.
   */
  it('keeps a real brand that contains a category word', () => {
    const wide = n.buildBrandIndex(['Nikka Whisky', 'Malt & Grain']);

    expect(wide.map((entry) => entry.key))
      .toEqual(['nikka whisky', 'malt grain']);

    expect(n.detectBrandFromName('Віскі Nikka Whisky Days 0,7л', wide))
      .toBe('Nikka Whisky');
    expect(n.detectBrandFromName('Compass Box Malt & Grain 0,7л', wide))
      .toBe('Malt & Grain');
  });

  it('fills only a missing brand, and only with an index', () => {
    const detected = n.normalize(snap('Віскі Arran Quarter Cask 0,7л'), index);

    expect(detected.brand).toBe('Arran');

    const scraped = n.normalize(
      snap('Віскі Arran Quarter Cask 0,7л', { brand: 'arran distillery' }),
      index,
    );

    expect(scraped.brand).toBe('Arran Distillery');

    const noIndex = n.normalize(snap('Віскі Arran Quarter Cask 0,7л'));

    expect(noIndex.brand).toBeNull();
  });
});

describe('NormalizeService.extractVolumeMl — gift sets', () => {
  it('sums the bottles of a set joined with a plus', () => {
    expect(
      n.extractVolumeMl(
        'Набор: віскі Wild Turkey 40.5% 0.7 л + віскі Wild Turkey 101, '
          + '50.5% 0.7 л',
      ),
    ).toBe(1400);
    expect(
      n.extractVolumeMl(
        'Набір бурбон Four Roses 1 л 40% + Four Roses Small Batch 0.7 л 45% '
          + '+ Four Roses Single Barrel 0.7 л 50% (2021000246296N)',
      ),
    ).toBe(2400);
    // The product code is joined with `+` too, and must not become a segment.
    expect(
      n.extractVolumeMl(
        'Віскі Jura Journey 0.7 л 40% + Jura 12yo 0.7 л 40% + Jura Rum Cask '
          + 'Finish 0.7 л 40% (5013967012462+5013967012509+5013967017849)',
      ),
    ).toBe(2100);
  });

  it('leaves a bottle, an accessory bundle and a multipack alone', () => {
    expect(n.extractVolumeMl('Віскі Highland Park 12yo 40% 0,7л')).toBe(700);
    expect(n.extractVolumeMl('Віскі Arran Barrel Reserve 0,7л + 2 склянки'))
      .toBe(700);
    // A brand really spelled with a plus.
    expect(n.extractVolumeMl('Віскі Roe + Co 45% 0,7л')).toBe(700);
    // The pack total is stated, so nothing is summed.
    expect(
      n.extractVolumeMl(
        'Упаковка віскі Hankey Bannister 40% 8.4 л '
          + '(0.7 л x 12 шт.)',
      ),
    ).toBe(8400);
  });
});
