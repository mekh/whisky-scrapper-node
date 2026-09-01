import 'reflect-metadata';

import { PeatProfile, ProducerAliasScope, ProducerKind } from '~enums';
import { KbAliasUtils, KbKeyUtils } from '~utils';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';

import type { KbAliasEntry, ProductSnapshot } from '~types';

const n = new NormalizeService();

/**
 * Builds the alias entries one producer would contribute to the index,
 * normalizing each spelling the way the seed importer does.
 *
 * @param slug - The producer slug, which doubles as its id here.
 * @param keys - The raw spellings that resolve to it.
 * @param name - Its display name.
 * @returns The alias entries, in the order given.
 */
function alias(slug: string, keys: string[], name: string): KbAliasEntry[] {
  return keys.map((key) => ({
    key: KbKeyUtils.key(key),
    scope: ProducerAliasScope.ANY,
    producer: {
      id: slug,
      slug,
      name,
      kind: ProducerKind.DISTILLERY,
      countryId: null,
      region: null,
      legalRegion: null,
      parentId: null,
      bottlerId: null,
      defaultTypeName: null,
      peatProfile: PeatProfile.UNKNOWN,
    },
  }));
}

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

describe('NormalizeService.resolveKeyBrand', () => {
  const index = KbAliasUtils.usable([
    ...alias('highland-park', ['Highland Park'], 'Highland Park'),
    ...alias('jack-daniels', ["Jack Daniel's"], "Jack Daniel's"),
    ...alias('macallan', ['Macallan', 'The Macallan'], 'Macallan'),
    ...alias('m-h', ['M H', 'M&H Elements'], 'M&H'),
    ...alias('arran', ['Arran'], 'Arran'),
    ...alias('jb', ['J&B'], 'J&B'),
  ]);

  /**
   * The whole point of resolving against the knowledge base: two shops
   * spelling one maker differently must sign the same bottling. The value is
   * the producer's slug rather than its name, so the key does not move when a
   * reviewer edits a display spelling.
   */
  it('folds every spelling of one producer onto its slug', () => {
    expect(n.resolveKeyBrand(snap('x', { brand: 'Macallan' }), index))
      .toBe('macallan');
    expect(n.resolveKeyBrand(snap('x', { brand: 'The Macallan' }), index))
      .toBe('macallan');
    expect(n.resolveKeyBrand(snap('x', { brand: 'M H' }), index))
      .toBe('m-h');
    expect(n.resolveKeyBrand(snap('x', { brand: 'M&h Elements' }), index))
      .toBe('m-h');
  });

  /**
   * A brand field states the brand and nothing else, so it is matched whole.
   * That is what lets `J&B` resolve at all — the five-character floor below
   * applies only to the substring path.
   */
  it('matches a short brand value as a whole string', () => {
    expect(n.resolveKeyBrand(snap('x', { brand: 'J&B' }), index)).toBe('jb');
  });

  it('reads a producer out of the name when the shop states none', () => {
    expect(n.resolveKeyBrand(snap('Віскі Highland Park 12yo 0,7л'), index))
      .toBe('highland-park');
    expect(n.resolveKeyBrand(snap('Jack Daniels Old No.7 40% 0,7л'), index))
      .toBe('jack-daniels');
  });

  it('does not match a producer inside a longer word', () => {
    expect(n.resolveKeyBrand(snap('Whisky arrangement gift box'), index))
      .toBeNull();
  });

  /**
   * A brand the knowledge base does not know keeps its own canonical
   * spelling, which is exactly what the key used before this pass existed —
   * an unresearched brand keeps working and simply stops improving.
   */
  it('falls back to the shop spelling when nothing resolves', () => {
    expect(n.resolveKeyBrand(snap('x', { brand: 'vulson' }), index))
      .toBe('Vulson');
    expect(n.resolveKeyBrand(snap('Віскі Vulson Rye 0,7л'), index))
      .toBeNull();
  });

  /**
   * The `& Whisky` collision, now guarded one layer deeper. A researcher
   * recorded goodwine's own department label verbatim and `KbKeyUtils.key`
   * deleted the ampersand, storing the bare noun `whisky` — six characters,
   * so the five-character floor cannot catch it, and sorted longest-first it
   * outranked every real brand no longer than the word.
   */
  it('ignores an alias that is nothing but a category word', () => {
    const poisoned = KbAliasUtils.usable([
      ...alias('and-whisky', ['& Whisky'], '& Whisky'),
      ...alias('umiki', ['Umiki'], 'Umiki'),
      ...alias('jura', ['Jura'], 'Jura'),
    ]);

    expect(poisoned.map((entry) => entry.key)).toEqual(['umiki', 'jura']);

    expect(n.resolveKeyBrand(snap('Віскі Umiki Whisky'), poisoned))
      .toBe('umiki');
  });

  /**
   * The guard must not cost a producer that merely contains a category word:
   * those carry identity in their other tokens.
   */
  it('keeps a producer whose name contains a category word', () => {
    const wide = KbAliasUtils.usable([
      ...alias('nikka', ['Nikka Whisky'], 'Nikka Whisky'),
      ...alias('compass-box', ['Malt & Grain'], 'Compass Box'),
    ]);

    expect(wide.map((entry) => entry.key))
      .toEqual(['nikka whisky', 'malt grain']);
  });
});

describe('NormalizeService.normalize brand handling', () => {
  /**
   * `normalize` no longer reads a brand out of the product name. That job
   * moved to the knowledge base, which answers it twice over — once for
   * identity in `resolveKeyBrand` and once for the label in
   * `KbResolverService` — so what stays on the snapshot is the one thing
   * neither records: the string the shop itself used, which is what
   * `product.brandOrig` stores for `pnpm research-brands` to read.
   */
  it('keeps the shop spelling and derives nothing from the name', () => {
    const stated = n.normalize(
      snap('Віскі Arran Quarter Cask 0,7л', { brand: 'arran distillery' }),
    );

    expect(stated.brand).toBe('Arran Distillery');

    const silent = n.normalize(snap('Віскі Arran Quarter Cask 0,7л'));

    expect(silent.brand).toBeNull();
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
