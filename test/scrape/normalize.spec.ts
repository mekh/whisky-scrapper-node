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

describe('NormalizeService.extractFlavorTags', () => {
  it('matches flavor keywords', () => {
    expect(n.extractFlavorTags("Laphroaig торф'яний дим")).toContain('peated');
    expect(n.extractFlavorTags('Macallan sherry oak')).toContain('sherry');
    expect(n.extractFlavorTags('звичайний бленд')).toEqual([]);
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
      rawAttrs: { description: "Островний торф'яний смак, 46%" },
    });

    n.normalize(s);

    expect(s.flavorTags).toContain('peated');
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
