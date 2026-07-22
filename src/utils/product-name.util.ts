/**
 * Leading category/marketing prefix: the run of characters before the first
 * Latin letter or digit (`Віскі `, `Набір: віскі `, the OK Wine
 * `<cyrillic> / <latin>` form, etc.).
 */
const LEADING_PREFIX = /^[^0-9A-Za-z]+/;

/**
 * Age statement, Latin spelling (`12yo`, `12 Y.O.`, `12YO`) → `12yo`. The
 * trailing guard stops it matching inside a word such as `young`.
 */
const AGE_YO = /(\d+)\s*y\.?o\.?(?![a-zа-яіїєґ])/gi;

/**
 * Age statement, word spelling (`3 роки витримки`, `4 Year Old`, `12 років`,
 * `14 years old`) → `12yo`. The guard stops a match inside a word (`yearly`).
 */
const AGE_WORDS =
  /(\d+)\s*(?:рік|роки|років|years?)(?![a-zа-яіїєґ])(?:\s+(?:витримки|old))?/gi;

/**
 * Trailing store product code in parentheses (Rozetka / MauDau), e.g.
 * `(142828)`, `(Q5225)`, `(3800032010292B)` — upper-case letters / digits /
 * `_` / `/` with at least one digit, so `(NAS)` or `(0.7л)` are kept.
 */
const PRODUCT_CODE = /\s*\([A-Z0-9_/]*\d[A-Z0-9_/]*\)\s*$/;

/**
 * Product-name helpers shared by the scraper import and name-cleanup tooling.
 */
export class ProductNameUtils {
  /**
   * Cleans a scraped product name for display: drops the leading category
   * prefix (everything before the first Latin letter or digit), normalises age
   * statements to a single `<years>yo` form, and strips a trailing store
   * product code in parentheses.
   *
   * @param raw - The raw product name as scraped.
   * @returns The cleaned name, or `null` when nothing meaningful remains
   *   (e.g. a bare `Віскі` with no brand at all).
   */
  public static clean(raw: string): string | null {
    const cleaned = raw
      .replace(LEADING_PREFIX, '')
      .replace(AGE_YO, '$1yo')
      .replace(AGE_WORDS, '$1yo')
      .replace(PRODUCT_CODE, '')
      .trim();

    return cleaned.length > 0 ? cleaned : null;
  }
}
