/**
 * Latin-only diacritic fold. A blanket `NFD` strip decomposes Cyrillic `й`
 * into `и`, which merges words that are genuinely different, so only a Latin
 * base letter gives up its combining marks (`Agitator Rök` -> `Agitator Rok`).
 */
const LATIN_DIACRITIC = /([A-Za-z])[̀-ͯ]+/g;

/**
 * Apostrophes are deleted rather than turned into a separator, so
 * `Ballantine's` and `Ballantines` fold to one token instead of two.
 */
const APOSTROPHES = /['’‘ʼ`´]/g;

/**
 * Everything outside the Latin and Ukrainian Cyrillic alphabets separates
 * tokens. Written as an explicit class because JS keeps `\w` / `\b` ASCII even
 * under the `u` flag (see the header of `scrape/normalize/normalize.service`).
 */
const NON_ALNUM = /[^0-9a-zа-яіїєґ]+/g;

/**
 * A volume with its unit still attached (`7л`, `075мл`). The only numeric
 * token dropped, because the key states volume separately.
 *
 * A **bare** number is deliberately kept, which is where this departs from the
 * legacy Python key. That key dropped every number so an ABV or age printed in
 * the name could not split a product — but `ProductNameUtils.clean` now lifts
 * strength, size and age into their own columns before the name is ever
 * stored, so a number that survives is almost always part of the name. Dropping
 * it merged products that are genuinely different: measured over the
 * catalogue, keeping numbers splits sixteen groups, thirteen of them correctly
 * — `Wild Turkey 81` from `Wild Turkey 101` (39 rows on one key),
 * `Maker's Mark 46` from `Maker's Mark`, `Glenfarclas 105` from `Glenfarclas`,
 * and the Octomore and Black Art releases from each other. The three it gets
 * wrong are cask numbers on the same bottling (`Tullibardine Sauternes Finish
 * 225`), which manual curation relinks. Cross-store groups went **up** over
 * the same measurement (1 268 to 1 272), so no spec leaked back in.
 *
 * A single-digit number needs no rule: the two-character minimum already
 * drops it, which is why `Label 5` still matches `Label`.
 */
const VOLUME_TOKEN = /^\d+(?:[.,]\d+)?(?:мл|л|l|ml)$/;

/**
 * Words that say what a whisky *is* rather than which whisky it is, plus the
 * packaging and grammar noise stores add to a listing. A token here is ignored
 * when the identity of a product is decided.
 *
 * This is a **paired vocabulary** with `CATEGORY_WORDS`, `ORIGIN_WORDS` and
 * `NAME_TAG_WORDS` in `product-name.util.ts`: those strip a word from the
 * display name, these ignore it when matching. A word added to one and not the
 * other drifts silently — edit them together.
 *
 * Every entry was checked against the catalogue, and the exclusions matter as
 * much as the list:
 *
 * - `bourbon` and `rye` are **not** here. Both head a cask or grain qualifier
 *   far more often than they name a category — `Bushmills Bourbon Finish` is a
 *   different whisky from `Bushmills Rum Finish`, and `Agitator Rye` from
 *   `Agitator Blended`. `product-name.util.ts` guards `bourbon` for the same
 *   reason.
 * - Regions (`islay`, `highland`, `speyside`) are never here: in this
 *   catalogue they are the name itself (`Highland Park`, `Islay Barley`), and
 *   `Clan Denny Islay` is not `Clan Denny Speyside`.
 * - Nationalities that head a brand are excluded on the evidence of the rows
 *   carrying them: `scottish` (`Scottish Leader`, `Scottish Collie`),
 *   `kentucky` (`Kentucky Owl`, `Pure Kentucky XO`), `canadian`
 *   (`Canadian Club`, `Canadian Mist`), `irish` (`Atom Irish #1`), `british`
 *   and `english` (`North British`, `The English`). Stripping any of them
 *   reduced a real brand to a single generic token.
 * - `grain` is excluded because `Nikka The Grain` and `Malt & Grain` are
 *   names, not categories, and the strip left them empty or collided them.
 * - `case`, `metal`, `tin`, `pack` and `pure` looked like packaging but every
 *   occurrence was a name (`Minor Case`, `Heavy Metal Years`, `Mix Pack`).
 *
 * `box` and `gb` **are** here: every occurrence is the gift-box marker a store
 * appends to an otherwise identical listing (`Glenmorangie GB`,
 * `Suntory Toki Box`), and `Compass Box` survives because its expression name
 * carries the product anyway.
 */
const MATCH_STOP_TOKENS: ReadonlySet<string> = new Set([
  'віскі',
  'виски',
  'whisky',
  'whiskey',
  'лікер',
  'liqueur',
  'scotch',
  'scotland',
  'ireland',
  'tennessee',
  'single',
  'malt',
  'blend',
  'blended',
  'gift',
  'box',
  'gb',
  'set',
  'the',
  'of',
  'and',
  'та',
  'із',
  'мл',
  'ml',
]);

/**
 * The Cyrillic half of the same vocabulary, matched by prefix because the
 * adjectives are declined (`односолодовий`, `односолодове`, `односолодового`)
 * and an exact list would need every form.
 *
 * Cyrillic-only by construction: a Latin stem test would eat `Setter` on
 * `set` or `Tubby` on `туб`'s transliteration.
 */
const MATCH_STOP_STEMS: readonly string[] = [
  'односолодов',
  'купажован',
  'солодов',
  'однозернов',
  'зернов',
  'житн',
  'бленд',
  'коробц',
  'коробк',
  'коробочц',
  'подарунков',
  'сувенірн',
  'упаковц',
  'упаковк',
  'пакуванн',
  'туб',
  'футляр',
  'витримк',
  'витриман',
];

/**
 * Builds the cross-store identity of a bottling.
 *
 * The same whisky is listed by up to nineteen stores, each with its own
 * wording, punctuation and packaging note, and the catalogue has no shared
 * identifier to join them on — the barcodes only overlap inside the Zakaz.ua
 * networks, which already agree on the name. What every store does state is
 * the product, its size and its age, so the key is a normalized signature of
 * those three: the significant words of the name (order-insensitive), the
 * brand collapsed to one token, then the volume and the age.
 *
 * Strength is deliberately **not** part of it. It is missing on roughly one
 * row in ten, and where two stores both state it they disagree often enough
 * (`Balvenie DoubleWood` at 40 % and 43 %) that including it would split a
 * bottling in two more often than it would keep two apart.
 *
 * This is the node port of the legacy `match_key` in the Python scraper
 * (`normalize.py`), whose shape it keeps verbatim so a key derived from the
 * stored catalogue and a key derived from a live scrape cannot disagree.
 */
export class ProductMatchUtils {
  /**
   * Derives the match key of one product.
   *
   * The surviving words are sorted and joined **without a separator**, so a
   * compound one store writes as one word and another as two still folds to
   * one key (`Balvenie Doublewood` / `Balvenie Double Wood`,
   * `Chivas Regal Crystalgold` / `Crystal Gold`) — the same trick
   * `spellingKey` in `scripts/clean-product-names.ts` uses. In principle two
   * different token splits could concatenate alike; measured over the
   * catalogue that never happened, and the join merged two more groups than
   * the spaced form, both of them one product spelled two ways.
   *
   * @param name - The cleaned display name (`ProductNameUtils.resolve`), or
   *   null when cleaning left nothing.
   * @param brand - The canonical brand name, or null when unknown.
   * @param volumeMl - Pack size in millilitres, or null when unknown.
   * @param age - Age statement in years, or null for a NAS bottling.
   * @returns The key, or null when no significant word survives — such a
   *   product cannot be matched and must stay on its own.
   */
  public static key(
    name: string | null,
    brand: string | null,
    volumeMl: number | null,
    age: number | null,
  ): string | null {
    const tokens = new Set(name ? ProductMatchUtils.nameTokens(name) : []);
    const brandToken = brand ? ProductMatchUtils.brandToken(brand) : '';

    if (brandToken) {
      tokens.add(brandToken);
    }

    if (tokens.size === 0) {
      return null;
    }

    const signature = [...tokens].sort().join('');

    return `${signature}|v${volumeMl ?? 0}|a${age ?? 0}`;
  }

  /**
   * Whether a brand name says *which* whisky this is rather than what kind of
   * drink it is.
   *
   * The question is already answered by the key: a brand contributes exactly
   * one token to a product's identity, and a brand made of nothing but
   * category words contributes none. Exposing it lets the brand-from-name
   * pass in `NormalizeService` ask the same question before it treats a brand
   * as something recognisable inside a product name — the two layers agree on
   * what a brand is, rather than each keeping its own list.
   *
   * The case this exists for is `& Whisky`, goodwine's own category label
   * (`&wine` / `&whisky` / `&food` name its departments) that a legacy import
   * left in the `brand` table. Every matcher in the codebase deletes the
   * ampersand, so the row reduces to the bare word `whisky` and claims every
   * whisky in the catalogue.
   *
   * @param brand - The canonical brand name.
   * @returns True when the brand carries identity of its own.
   */
  public static carriesIdentity(brand: string): boolean {
    return ProductMatchUtils.brandToken(brand).length > 0;
  }

  /**
   * Folds one string to the alphabet the key is built from.
   *
   * @param text - The raw name or brand.
   * @returns Lower-case, diacritic-free, space-separated words.
   */
  private static fold(text: string): string {
    return text
      .normalize('NFD')
      .replace(LATIN_DIACRITIC, '$1')
      .normalize('NFC')
      .toLowerCase()
      .replace(APOSTROPHES, '')
      .replace(NON_ALNUM, ' ')
      .trim();
  }

  /**
   * Extracts the significant words of a product name.
   *
   * @param name - The cleaned display name.
   * @returns The words that identify the product, in source order.
   */
  private static nameTokens(name: string): string[] {
    return ProductMatchUtils.fold(name)
      .split(' ')
      .filter((token) =>
        token.length >= 2
        && !ProductMatchUtils.isStopWord(token)
        && !VOLUME_TOKEN.test(token)
      );
  }

  /**
   * Collapses a brand to the single token that represents it.
   *
   * Joined without separators so `Highland Park` and `Highland  Park` are one
   * token, and stop-filtered so the article in `The Glenlivet` cannot make it
   * a different brand from `Glenlivet`. Short parts are kept, which is what
   * saves `J & B` from folding to nothing.
   *
   * @param brand - The canonical brand name.
   * @returns The brand token, or an empty string when nothing survives.
   */
  private static brandToken(brand: string): string {
    return ProductMatchUtils.fold(brand)
      .split(' ')
      .filter((part) => part.length > 0 && !ProductMatchUtils.isStopWord(part))
      .join('');
  }

  /**
   * Tells whether a token says what the whisky is rather than which one.
   *
   * @param token - A folded token.
   * @returns True when the token carries no identity.
   */
  private static isStopWord(token: string): boolean {
    if (MATCH_STOP_TOKENS.has(token)) {
      return true;
    }

    return MATCH_STOP_STEMS.some((stem) => token.startsWith(stem));
  }
}
