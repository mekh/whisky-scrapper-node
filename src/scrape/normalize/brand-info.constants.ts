/**
 * Origin country (Ukrainian name) and whisky type inferred from a known brand.
 * `type` is null for brands with mixed line-ups (the type is taken from the
 * product name instead).
 */
export interface BrandInfo {
  /**
   * Origin country, Ukrainian name.
   */
  country: string;

  /**
   * Whisky type, or null when the brand spans several types.
   */
  type: string | null;
}

const SC_SM: BrandInfo = { country: 'Шотландія', type: 'single malt' };
const SC_BL: BrandInfo = { country: 'Шотландія', type: 'blend' };
const IE: BrandInfo = { country: 'Ірландія', type: null };
const US_BB: BrandInfo = { country: 'США', type: 'bourbon' };
const JP: BrandInfo = { country: 'Японія', type: null };
const SC_ANY: BrandInfo = { country: 'Шотландія', type: null };

const SCOTTISH_SINGLE_MALT = [
  'glenfiddich',
  'glenlivet',
  'macallan',
  'glenmorangie',
  'balvenie',
  'aberlour',
  'glenfarclas',
  'glenallachie',
  'arran',
  'talisker',
  'oban',
  'dalmore',
  'glenrothes',
  'glengoyne',
  'glendronach',
  'benriach',
  'benromach',
  'bunnahabhain',
  'bowmore',
  'laphroaig',
  'lagavulin',
  'ardbeg',
  'caol ila',
  'kilchoman',
  'bruichladdich',
  'springbank',
  'glen scotia',
  'glen moray',
  'glen grant',
  'glenkinchie',
  'cardhu',
  'dalwhinnie',
  'cragganmore',
  'mortlach',
  'craigellachie',
  'aberfeldy',
  'tomatin',
  'tomintoul',
  'tobermory',
  'ledaig',
  'deanston',
  'tamdhu',
  'tamnavulin',
  'knockando',
  'auchentoshan',
  'tullibardine',
  'bladnoch',
  'edradour',
  'jura',
  'scapa',
  'highland park',
  'old pulteney',
  'ancnoc',
  'an cnoc',
  'balblair',
  'clynelish',
  'fettercairn',
  'longmorn',
  'royal brackla',
  'speyburn',
  'strathisla',
  'wolfburn',
  'ardmore',
  'ben nevis',
  'blair athol',
  'linkwood',
  'loch lomond',
  'kilkerran',
  'glen elgin',
  'glenglassaugh',
  'inchgower',
  'aultmore',
  'dailuaine',
];

const SCOTTISH_BLEND = [
  'chivas',
  'ballantine',
  'ballantines',
  'grant s',
  'grants',
  'grant',
  'famous grouse',
  'naked grouse',
  'dewar',
  'dewars',
  'johnnie walker',
  'label 5',
  'label5',
  'bell s',
  'bells',
  'whyte mackay',
  'cutty sark',
  'j b',
  'vat 69',
  'teacher',
  'monkey shoulder',
  'hankey bannister',
  'william lawson',
  'black white',
  'passport',
  'clan campbell',
  'scottish leader',
  'william grant',
  'compass box',
  'big peat',
];

const IRISH = [
  'jameson',
  'tullamore',
  'bushmills',
  'teeling',
  'west cork',
  'the quiet man',
  'redbreast',
  'powers',
  'paddy',
  'connemara',
  'kilbeggan',
  'green spot',
  'yellow spot',
  'writers tears',
  'writer s tears',
  'slane',
  'roe co',
  'method and madness',
  'busker',
];

const AMERICAN_BOURBON = [
  'jim beam',
  'makers mark',
  'maker s mark',
  'wild turkey',
  'buffalo trace',
  'woodford',
  'four roses',
  'knob creek',
  'bulleit',
  'elijah craig',
  'evan williams',
  'eagle rare',
  'blanton',
  'blantons',
  'jefferson',
  'michters',
  'michter s',
  'ezra brooks',
  'yellowstone',
  'heaven hill',
  'old grand dad',
  'rossville',
];

const JAPANESE = [
  'nikka',
  'suntory',
  'hibiki',
  'yamazaki',
  'hakushu',
  'yoichi',
  'miyagikyo',
  'chita',
  'toki',
  'mars',
  'shinshu',
  'akkeshi',
  'kurayoshi',
  'matsui',
  'ohishi',
  'fuji',
];

const SCOTTISH_SINGLE_MALT_2 = [
  'singleton',
  'smokehead',
  'scarabus',
  'ardnahoe',
  'ballechin',
  'lagg',
  'pokeno',
  'glencoe',
  'raasay',
  'torabhaig',
  'lochlea',
  'annandale',
  'ardnamurchan',
  'glenturret',
  'isle of harris',
  'nc nean',
  'ncnean',
];

const SCOTTISH_BLEND_2 = [
  'highland queen',
  'black bottle',
  'white horse',
  'islay mist',
  'lauder',
  'lauders',
  'the deacon',
  'grand macnish',
  'claymore',
  'kings barrel',
  'obrian',
  'o brian',
  'shackleton',
  'sheep dip',
  'the six isles',
];

const AMERICAN_BOURBON_2 = [
  'willett',
  'coalition',
  'pickup truck',
  'rebel',
  'old forester',
  '1792',
  'larceny',
  'very old barton',
  'booker',
  'basil hayden',
];

const INDEPENDENT_BOTTLERS = [
  'signatory',
  'gordon macphail',
  'douglas laing',
  'cadenhead',
  'hunter laing',
  'adelphi',
  'berry bros',
  'elixir',
  'single malts of scotland',
  'chapter 7',
];

/**
 * Builds `[brand, info]` entries for a list of brand keys.
 *
 * @param brands - Brand keys.
 * @param info - The shared brand info.
 * @returns Map entries.
 */
function entries(
  brands: string[],
  info: BrandInfo,
): [string, BrandInfo][] {
  return brands.map((brand) => [brand, info]);
}

/**
 * Brand → origin/type lookup. Later entries override earlier ones on a key
 * collision, matching the Python dict-spread order.
 */
export const BRAND_INFO = new Map<string, BrandInfo>([
  ...entries(SCOTTISH_SINGLE_MALT, SC_SM),
  ...entries(SCOTTISH_BLEND, SC_BL),
  ...entries(IRISH, IE),
  ...entries(AMERICAN_BOURBON, US_BB),
  ['jack daniel', { country: 'США', type: 'tennessee' }],
  ['jack daniels', { country: 'США', type: 'tennessee' }],
  ['george dickel', { country: 'США', type: 'tennessee' }],
  ['sazerac', { country: 'США', type: 'rye' }],
  ['rittenhouse', { country: 'США', type: 'rye' }],
  ...entries(JAPANESE, JP),
  ['kavalan', { country: 'Тайвань', type: 'single malt' }],
  ['amrut', { country: 'Індія', type: 'single malt' }],
  ['paul john', { country: 'Індія', type: 'single malt' }],
  ['rampur', { country: 'Індія', type: 'single malt' }],
  ['penderyn', { country: 'Уельс', type: 'single malt' }],
  ['canadian club', { country: 'Канада', type: 'blend' }],
  ['crown royal', { country: 'Канада', type: 'blend' }],
  ['cotswolds', { country: 'Англія', type: 'single malt' }],
  ['bimber', { country: 'Англія', type: 'single malt' }],
  ['mackmyra', { country: 'Швеція', type: 'single malt' }],
  ['high coast', { country: 'Швеція', type: 'single malt' }],
  ...entries(SCOTTISH_SINGLE_MALT_2, SC_SM),
  ...entries(SCOTTISH_BLEND_2, SC_BL),
  ...entries(AMERICAN_BOURBON_2, US_BB),
  ['black velvet', { country: 'Канада', type: 'blend' }],
  ['lakes', { country: 'Англія', type: 'single malt' }],
  ['lauder s', SC_BL],
  ...entries(INDEPENDENT_BOTTLERS, SC_ANY),
]);

/**
 * Brand keys ordered longest-first, so a more specific brand wins the lookup.
 */
export const BRAND_KEYS = [...BRAND_INFO.keys()].sort(
  (a, b) => b.length - a.length,
);

/**
 * Flavor tag → keyword list (Ukrainian / English). Spaces inside keywords are
 * significant (`px `, `med `).
 */
export const FLAVOR_KEYWORDS: [string, string[]][] = [
  ['peated', ['peat', 'peated', 'торф', "торф'ян", 'торфян']],
  ['smoky', ['smok', 'дим', 'димн']],
  ['sherry', ['sherry', 'хересн', 'херес', 'oloroso', 'px ', 'pedro ximenez']],
  ['bourbon-cask', ['bourbon cask', 'бурбонн', 'ex-bourbon']],
  ['vanilla', ['vanilla', 'ваніл']],
  ['honey', ['honey', 'медов', 'мед ']],
  ['fruity', ['fruit', 'фрукт', 'ягідн', 'ягод']],
  ['chocolate', ['chocolat', 'шоколад', 'какао']],
  ['spicy', ['spic', 'прян', 'перц']],
  ['floral', ['floral', 'квітков', 'квіток']],
];

/**
 * Whisky type → keyword list. More specific types come first.
 */
export const TYPE_KEYWORDS: [string, string[]][] = [
  ['single malt', ['односолодов', 'single malt', 'single-malt']],
  ['blend', ['купажован', 'бленд', 'blended', 'blend']],
  ['grain', ['зернов', 'grain']],
  ['bourbon', ['бурбон', 'bourbon']],
  ['rye', ['житн', ' rye', 'rye ']],
  ['tennessee', ['tennessee', 'теннессі', 'теннесі']],
  ['malt', ['солодов', 'malt']],
];

/**
 * Origin country (Ukrainian name) → keyword list.
 */
export const COUNTRY_KEYWORDS: [string, string[]][] = [
  ['Шотландія', ['шотланд', 'scotch', 'scotland']],
  ['Ірландія', ['ірланд', 'irish', 'ireland']],
  ['Японія', ['япон', 'japan']],
  ['Канада', ['канад', 'canad']],
  ['Індія', ['інді', 'india']],
  [
    'США',
    ['kentucky', 'кентуккі', 'american whiskey', 'теннессі', 'tennessee'],
  ],
  ['Англія', ['англійськ', 'english whisky']],
  ['Уельс', ['уельс', 'welsh']],
  ['Тайвань', ['тайван', 'taiwan']],
];

/**
 * Umbrella country names that clash with the Scotland/England/Wales taxonomy.
 * Dropped to null so the brand/keyword pass can refine them.
 */
export const UMBRELLA_COUNTRIES = new Set([
  'великобританія',
  'велика британія',
  'сполучене королівство',
  'uk',
]);
