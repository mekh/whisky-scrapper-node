/**
 * Word separators inside a brand: whitespace, hyphen, underscore, and every
 * apostrophe/backtick variant. A lone trailing `s` left by an apostrophe slug
 * (`ballantine-s`) is re-attached as a possessive by `titleCase`.
 */
const BRAND_SEPARATOR = /[\s'’‘`´_-]+/g;

/**
 * Wrapping quotes/whitespace stripped from both ends before matching.
 */
const BRAND_WRAP = /^["“”«»'’‘`´\s]+|["“”«»'’‘`´\s]+$/g;

/**
 * Runs of whitespace collapsed to a single space.
 */
const WHITESPACE = /\s+/g;

/**
 * True when the value contains any Cyrillic letter.
 */
const HAS_CYRILLIC = /[а-яіїєґ]/i;

/**
 * Connector words kept lower-case when they are not the first word.
 */
const LOWER_WORDS = new Set(['of', 'and']);

/**
 * Non-brand placeholders some feeds put in the brand field, treated as absent.
 */
const JUNK = new Set(['no brand', 'nobrand', 'none', 'unknown']);

/**
 * Known Cyrillic trademarks mapped to their canonical Latin brand, keyed by the
 * normalized brand key. Cyrillic values not listed here are dropped: either a
 * wrong trademark (`вінтер` on a Grant's product) or a bottler series rather
 * than a brand (`спейсайд селекшн №5`).
 */
const CYRILLIC_ALIASES = new Map<string, string>([
  ['тормор', 'Tormore'],
  ['клайнліш', 'Clynelish'],
  ['лонгморн', 'Longmorn'],
  ['капердонік', 'Caperdonich'],
  ['гленлоссі', 'Glenlossie'],
  ['буффало трейс', 'Buffalo Trace'],
  ['кроу роял', 'Crown Royal'],
  ['ірішмен', 'The Irishman'],
  ['пайп меідже', 'Pipe Major'],
]);

/**
 * Latin display spellings that plain title-casing would flatten (camelCase
 * distilleries, acronyms), keyed by the normalized brand key.
 */
const DISPLAY_OVERRIDES = new Map<string, string>([
  ['ancnoc', 'AnCnoc'],
  ['an cnoc', 'AnCnoc'],
  ['benriach', 'BenRiach'],
  ['glenaladale', 'GlenAladale'],
  ['clan macgregor', 'Clan MacGregor'],
  ['gordon macphail', 'Gordon & MacPhail'],
  ['gordon & macphail', 'Gordon & MacPhail'],
  ['macarthur s', "MacArthur's"],
  ['mcclelland s', "McClelland's"],
  ['mcconnell s', "McConnell's"],
  ['mcgibbon s', "McGibbon's"],
  ['mcivor', 'McIvor'],
  ['few', 'FEW'],
  ['tbwc', 'TBWC'],
  ['pure kentucky xo', 'Pure Kentucky XO'],
  ['vat 69', 'VAT 69'],
]);

/**
 * Brand-name canonicalization shared by the SQLite import and periodic sync.
 * Mirrors the Python `normalize.canonical_brand` helper so both writers fold a
 * brand onto exactly the same spelling.
 */
export class BrandUtils {
  /**
   * Folds a scraped brand onto its single canonical spelling.
   *
   * Collapses the case/whitespace/punctuation variants different stores emit
   * for the same brand (MauDau's lower-case hyphenated slug, Zakaz's trademark
   * with trailing spaces, etc.) and maps the known Cyrillic trademarks back to
   * their Latin brand.
   *
   * @param raw - The raw brand value as scraped, or null/undefined.
   * @returns The canonical brand spelling, or null when the value is empty, a
   *   junk placeholder, or an unmapped Cyrillic trademark.
   */
  public static canonical(raw: string | null | undefined): string | null {
    if (!raw) {
      return null;
    }

    const text = raw.replace(BRAND_WRAP, '').replace(WHITESPACE, ' ').trim();

    if (!text) {
      return null;
    }

    const key = BrandUtils.key(text);

    if (!key || JUNK.has(key)) {
      return null;
    }

    if (HAS_CYRILLIC.test(text)) {
      return CYRILLIC_ALIASES.get(key) ?? null;
    }

    return DISPLAY_OVERRIDES.get(key) ?? BrandUtils.titleCase(key);
  }

  /**
   * Builds the match key for a brand: lower-cased with every separator run
   * collapsed to a single space.
   *
   * @param text - The cleaned brand text.
   * @returns The normalized match key.
   */
  private static key(text: string): string {
    return text.toLowerCase().replace(BRAND_SEPARATOR, ' ').trim();
  }

  /**
   * Title-cases a brand key, re-attaching a possessive `'s` and keeping the
   * connector words (`of`/`and`) lower-case.
   *
   * @param key - The normalized brand key.
   * @returns The title-cased display spelling.
   */
  private static titleCase(key: string): string {
    const out: string[] = [];

    key.split(' ').forEach((word, index) => {
      if (word === 's' && out.length > 0) {
        out[out.length - 1] = `${out[out.length - 1]}'s`;

        return;
      }

      if (index > 0 && LOWER_WORDS.has(word)) {
        out.push(word);

        return;
      }

      out.push(word.charAt(0).toUpperCase() + word.slice(1));
    });

    return out.join(' ');
  }
}
