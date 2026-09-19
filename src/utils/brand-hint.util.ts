/**
 * The trademark token a shop appends to a listing name, in the two spellings
 * the catalogue carries: `(Ірландія, ТМ Hyde)` with Cyrillic `ТМ`, and
 * `(Ірландія, TM Kinahan's)` with Latin `TM`. The two letter pairs look
 * identical and are different code points, which is exactly why this lives in
 * one place.
 *
 * Anchored to the closing parenthesis so the capture stops at the end of the
 * parenthetical rather than eating the rest of the name.
 */
const TM_TOKEN = /(?:^|[(,\s])(?:ТМ|TM)\s+([^)]+)\)/u;

/**
 * Shortest brand a token may state. Below this the value is punctuation or a
 * stray letter rather than a maker's name.
 */
const MIN_BRAND_LENGTH = 2;

/**
 * Reads the brand a shop states inside a listing name rather than in a field
 * of its own.
 *
 * `vina-mira` writes `(Країна, ТМ Brand)` at the end of every listing it
 * knows the maker of, and the name cleaner strips the whole parenthetical — so
 * the brand was present in the data and used by nothing. Sixty of the
 * sixty-seven unresolved bottlings that shop contributed carry such a token.
 *
 * One place for the regex because two readers want it: the adapter, which
 * hands the token over as the stated brand so whole-string brand matching can
 * use it, and the review screen's suggestions, which offers it as a producer
 * candidate for a bottling already stored.
 */
export class BrandHintUtils {
  /**
   * Extracts the trademark token from a raw listing name.
   *
   * @param rawName - The shop's own name for the listing.
   * @returns The stated brand, trimmed, or null when the name states none.
   */
  public static fromRawName(rawName: string | null): string | null {
    if (!rawName) {
      return null;
    }

    const stated = TM_TOKEN.exec(rawName)?.[1]?.trim() ?? '';

    return stated.length >= MIN_BRAND_LENGTH ? stated : null;
  }
}
