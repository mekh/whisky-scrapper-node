import { NameAgeSearch } from '~types';

/**
 * A search term that ends in an age statement: a name part, a whitespace run,
 * then the age. At most two digits, so a vintage (`Ardbeg 1998`) or a volume
 * in millilitres (`Chivas 700`) is never read as an age — the oldest bottling
 * in the catalogue is 51 years old. The name part has to hold a non-space
 * character, so a bare number stays a plain substring search instead of
 * turning into an age-only one.
 */
const TRAILING_AGE = /^(.*\S)\s+(\d{1,2})$/;

export class SearchTermUtils {
  /**
   * Splits a name search that ends in a number into its name part and the age
   * that number states.
   *
   * Users type the age the way the catalogue prints it (`Glenfiddich 12`),
   * but the age lives in its own column and is stripped from the canonical
   * name, so the term matches nothing as a single substring — not even when
   * `Glenfiddich Triple Oak` is a 12-year-old. Splitting it lets the caller
   * match the name part and the age separately.
   *
   * @param term - The raw search term; blank or absent yields null.
   * @returns The name part and the age, or null when the term does not end in
   *   a one- or two-digit number.
   */
  public static splitAge(
    term: string | null | undefined,
  ): NameAgeSearch | null {
    const match = TRAILING_AGE.exec(term?.trim() ?? '');

    if (!match) {
      return null;
    }

    return { name: match[1], age: Number(match[2]) };
  }
}
