import 'reflect-metadata';

import { ProductNameUtils } from '~utils';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';

import type { ProductSnapshot } from '~types';

const n = new NormalizeService();
const clean = (raw: string): string | null => ProductNameUtils.clean(raw);

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

describe('ProductNameUtils.clean', () => {
  it('strips the category prefix', () => {
    expect(clean('Віскі Jameson 0,7л')).toBe('Jameson 0,7л');
    expect(clean('Набір: віскі Chivas 12')).toBe('Chivas 12');
    expect(clean('Bourbon Jim Beam')).toBe('Bourbon Jim Beam');
    expect(clean('Віскі')).toBeNull();
  });

  it('normalizes age statements to <n>yo', () => {
    expect(clean('Віскі Гленлівет / Glenlivet 12 років'))
      .toBe('Glenlivet 12yo');
    expect(clean('Aberlour 12 y.o. 0.7л')).toBe('Aberlour 12yo 0.7л');
    expect(clean('Glenfiddich 12 Years Old, 40%'))
      .toBe('Glenfiddich 12yo, 40%');
    expect(clean('Bushmills, 8 років витримки, 0.7'))
      .toBe('Bushmills, 8yo, 0.7');
    expect(clean('Talisker 4 Year Old, 0.7л')).toBe('Talisker 4yo, 0.7л');
    expect(clean('Nikka 3 роки витримки')).toBe('Nikka 3yo');
    expect(clean('Jura 10yo')).toBe('Jura 10yo');
    expect(clean('12 young oak')).toBe('12 young oak');
    expect(clean('Glen 12 yearly release')).toBe('Glen 12 yearly release');
  });

  it('strips a trailing store product code', () => {
    expect(clean('Glen Turner 40% (3147697523508)')).toBe('Glen Turner 40%');
    expect(clean('Macallan (142828)')).toBe('Macallan');
    expect(clean('Whisky (Q5225)')).toBe('Whisky');
    expect(clean('Whisky (3800032010292B)')).toBe('Whisky');
    expect(clean('Whisky (5000299628034_AB)')).toBe('Whisky');
    expect(clean('Ardbeg (NAS)')).toBe('Ardbeg (NAS)');
    expect(clean('Something (0.7)')).toBe('Something (0.7)');
  });
});
