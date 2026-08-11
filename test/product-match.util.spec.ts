import { ProductMatchUtils } from '~utils';

/**
 * Shorthand for the common case: a name and a brand at the same size and age.
 */
const key = (
  name: string | null,
  brand: string | null = null,
  volumeMl: number | null = 700,
  age: number | null = null,
): string | null => ProductMatchUtils.key(name, brand, volumeMl, age);

describe('ProductMatchUtils.key — products that must match', () => {
  it('ignores case, apostrophes, punctuation and spacing', () => {
    expect(key("Jack Daniel's")).toBe(key('Jack Daniels'));
    expect(key('Caol Ila')).toBe(key('Caol ila'));
    expect(key('TENJAKU')).toBe(key('Tenjaku'));
    expect(key("Ballantine's Finest")).toBe(key('Ballantines Finest'));
    expect(key('J & B Rare')).toBe(key('J&B Rare'));
    expect(key('Balvenie Doublewood')).toBe(key('Balvenie Double Wood'));
    expect(key('Aerstone, Land Cask')).toBe(key('Aerstone Land Cask'));
  });

  it('folds a Latin diacritic but leaves Cyrillic alone', () => {
    expect(key('Agitator Rök')).toBe(key('Agitator Rok'));
    expect(key('Éiregold')).toBe(key('Eiregold'));
    /**
     * `й` must not decompose into `и`: the two are different letters, and a
     * blanket NFD strip would merge words that are genuinely different.
     */
    expect(key('Стакан')).not.toBe(key('Стакай'));
  });

  it('ignores the article, in the name and in the brand alike', () => {
    expect(key('The Glenlivet')).toBe(key('Glenlivet'));
    expect(key('Glenlivet', 'The Glenlivet')).toBe(
      key('Glenlivet', 'Glenlivet'),
    );
    expect(key('The Pogues Streams of')).toBe(key('The Pogues Streams'));
  });

  it('ignores word order', () => {
    expect(key('Johnnie Walker Red Label'))
      .toBe(key('Red Label Johnnie Walker'));
    expect(key('Suntory Hibiki Japanese Harmony'))
      .toBe(key('Hibiki Japanese Harmony Suntory'));
  });

  it('ignores the category words a listing prefixes or trails', () => {
    expect(key('Glenfarclas Malt')).toBe(key('Glenfarclas'));
    expect(key('Robert Burns Blend')).toBe(key('Robert Burns'));
    expect(key("Jack Daniel's Tennessee Single Barrel"))
      .toBe(key("Jack Daniel's Single Barrel"));
  });

  it('ignores the gift packaging one store appends', () => {
    expect(key('Glenmorangie GB')).toBe(key('Glenmorangie'));
    expect(key('Suntory Toki Box')).toBe(key('Suntory Toki'));
    expect(key('Aberlour у подарунковій коробці')).toBe(key('Aberlour'));
    expect(key('Aberlour в тубусі')).toBe(key('Aberlour'));
  });

  it('collapses a multi-word brand to one token', () => {
    expect(key('Caol Ila', 'Gordon & MacPhail'))
      .toBe(key('Caol Ila', 'Gordon MacPhail'));
    /**
     * Short parts are kept in the brand, unlike in the name: dropping them
     * would fold `J & B` to nothing at all.
     */
    expect(key('Rare', 'J & B')).toBe(key('Rare', 'J&B'));
  });

  it('ignores a single digit, which is never a distinguishing number', () => {
    expect(key('Label 5')).toBe(key('Label'));
  });
});

describe('ProductMatchUtils.key — products that must not match', () => {
  it('separates a region, which is part of the name here', () => {
    expect(key('Clan Denny Islay')).not.toBe(key('Clan Denny Speyside'));
    expect(key('Highland Park')).not.toBe(key('Park'));
  });

  it('separates a cask qualifier headed by a category word', () => {
    expect(key('Bushmills Bourbon Finish'))
      .not.toBe(key('Bushmills Rum Finish'));
    expect(key('Agitator Blended')).not.toBe(key('Agitator Rye'));
  });

  it('separates the numbered expressions of one brand', () => {
    expect(key('Wild Turkey 101')).not.toBe(key('Wild Turkey 81'));
    expect(key('Wild Turkey 101')).not.toBe(key('Wild Turkey'));
    expect(key("Maker's Mark 46")).not.toBe(key("Maker's Mark"));
    expect(key('Glenfarclas 105')).not.toBe(key('Glenfarclas'));
    expect(key('Bruichladdich Octomore 12.2'))
      .not.toBe(key('Bruichladdich Octomore 16.1'));
  });

  it('separates a vintage', () => {
    expect(key('Scyfion Aultmore 2006')).not.toBe(key('Scyfion Aultmore 2011'));
  });

  it('separates by size and by age', () => {
    expect(key('Aberlour', null, 700, 12)).not.toBe(
      key('Aberlour', null, 700, 18),
    );
    expect(key('Aberlour', null, 700, 12)).not.toBe(
      key('Aberlour', null, 1000, 12),
    );
    /**
     * A NAS bottling and an aged one are different products, and an unknown
     * size is its own bucket rather than a wildcard.
     */
    expect(key('Aberlour', null, 700, null)).not.toBe(
      key('Aberlour', null, 700, 12),
    );
    expect(key('Aberlour', null, null, null)).not.toBe(
      key('Aberlour', null, 700, null),
    );
  });

  it('keeps a brand that reads like a category or a nationality', () => {
    expect(key('Compass Box Glasgow')).not.toBe(key('Glasgow'));
    expect(key('Minor Case Rye')).not.toBe(key('Rye'));
    expect(key('North British')).not.toBe(key('North'));
    expect(key('Scottish Leader')).not.toBe(key('Leader'));
    expect(key('Kentucky Owl')).not.toBe(key('Owl'));
    expect(key('Canadian Club')).not.toBe(key('Club'));
    expect(key('Nikka The Grain')).not.toBe(key('Nikka'));
  });
});

describe('ProductMatchUtils.key — shape and edge cases', () => {
  it('states volume and age after the signature', () => {
    expect(key('Aberlour', null, 700, 12)).toBe('aberlour|v700|a12');
    expect(key('Aberlour', null, null, null)).toBe('aberlour|v0|a0');
  });

  it('joins the words, so a compound spelling folds either way', () => {
    expect(key('Chivas Regal Crystalgold')).toBe(
      key('Chivas Regal Crystal Gold'),
    );
    expect(key('Glen Grant')).toBe(key('Glengrant'));
  });

  it('returns null when no word survives', () => {
    expect(key(null)).toBeNull();
    expect(key('')).toBeNull();
    expect(key('   ')).toBeNull();
    expect(key('Віскі односолодовий у подарунковій коробці')).toBeNull();
    expect(key('Whisky', '')).toBeNull();
  });

  it('keeps the brand when the name alone yields nothing', () => {
    expect(key('Whisky', 'Jameson')).toBe('jameson|v700|a0');
  });

  it('is pure — the same inputs always give the same key', () => {
    const name = 'Bruichladdich Octomore 15.2';

    expect(key(name, 'Bruichladdich')).toBe(key(name, 'Bruichladdich'));
  });
});
