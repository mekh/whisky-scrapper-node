/**
 * Cyrillic letters kept in a normalized key. JS `\w` stays ASCII even under
 * the `u` flag, so the class is spelled out — the same reason
 * `normalize.service.ts` spells out its own.
 */
const CYRILLIC = 'а-яіїєґ';

/**
 * Any run of characters that is not a letter or digit. Collapsed to one space
 * so a key is a sequence of whole words.
 */
const NON_ALNUM = new RegExp(`[^0-9a-z${CYRILLIC}]+`, 'gi');

/**
 * Apostrophes, in the several shapes the catalogue's sources use.
 */
const APOSTROPHES = /['`’´]/g;

/**
 * A base letter that may have its accents folded away — ASCII Latin only.
 */
const LATIN_BASE = /[a-z]/i;

/**
 * Normalizes producer names, aliases, brands and product names to the single
 * form the knowledge-base resolver matches on.
 *
 * This deliberately duplicates `NormalizeService.brandHaystack` instead of
 * reusing it, and differs from it in exactly one way: **Latin accents are
 * folded**, so `Mòine` and `Moine` produce the same key. That matters because
 * one store's cleaner already emitted `Bunnahabhain Moine` while another will
 * spell it `Mòine`, and a peat rule that silently fails to match is precisely
 * the class of error this work exists to remove.
 *
 * The folding is restricted to Latin base letters, and that restriction is
 * load-bearing rather than cautious: several Cyrillic letters are themselves
 * composed, so stripping every combining mark turns `Хайленд` into `хаиленд`
 * and `Торф'яний` into `торфянии`. Folding by script keeps `й`, `ї` and `ё`
 * intact while still collapsing `Mòine`, `Àrd` and `Dhà`.
 *
 * `brandHaystack` must **not** gain the same folding: it feeds
 * `ProductMatchUtils.key`, and the match key is frozen at creation, so
 * changing what it produces would split bottlings that are already linked.
 * The two functions are near-copies on purpose — keep this note in step with
 * the one on `brandHaystack`.
 */
export class KbKeyUtils {
  /**
   * Normalizes text to a space-wrapped key: lower-cased, Latin accents folded,
   * apostrophes removed, every other non-alphanumeric run collapsed to a
   * single space.
   *
   * The result is wrapped in single spaces so a caller can test for
   * ` needle ` and get a whole-word match for free — the technique
   * `detectBrandFromName` already uses.
   *
   * @param text - Raw brand, product name or alias.
   * @returns The space-wrapped key. A text with no letters or digits yields a
   *   single space, which matches nothing.
   */
  public static normalize(text: string): string {
    const folded = KbKeyUtils.foldLatinAccents(text.toLowerCase())
      .replace(APOSTROPHES, '')
      .replace(NON_ALNUM, ' ')
      .trim();

    return ` ${folded} `;
  }

  /**
   * The normalized key without its wrapping spaces — the form stored in
   * `producer_alias.key` and `flavor_rule.pattern`.
   *
   * @param text - Raw brand, product name or alias.
   * @returns The trimmed key, empty when the text carries nothing matchable.
   */
  public static key(text: string): string {
    return KbKeyUtils.normalize(text).trim();
  }

  /**
   * Whether a normalized haystack contains a pattern as whole words.
   *
   * @param haystack - A key produced by {@link normalize} (space-wrapped).
   * @param pattern - A trimmed pattern produced by {@link key}.
   * @returns True when the pattern appears as a complete word sequence.
   */
  public static matchesWord(haystack: string, pattern: string): boolean {
    if (!pattern) {
      return false;
    }

    return haystack.includes(` ${pattern} `);
  }

  /**
   * Whether a normalized haystack contains a pattern at the start of a word.
   *
   * This is the mode Ukrainian inflection needs: `торф` has to reach
   * `торф'яний`, `торфяний` and `торфяністю` without the rule listing every
   * form. It only ever anchors at a word boundary, so `peat` still cannot fire
   * inside `repeat`.
   *
   * @param haystack - A key produced by {@link normalize} (space-wrapped).
   * @param pattern - A trimmed pattern produced by {@link key}.
   * @returns True when some word of the haystack starts with the pattern.
   */
  public static matchesPrefix(haystack: string, pattern: string): boolean {
    if (!pattern) {
      return false;
    }

    return haystack.includes(` ${pattern}`);
  }

  /**
   * Strips accents from Latin letters and leaves every other script alone.
   *
   * Decomposing and dropping all combining marks would also rewrite Cyrillic:
   * `й` is `и` plus a breve and `ї` is `і` plus a diaeresis, so a blanket fold
   * silently corrupts every Ukrainian alias. Folding per character, and only
   * where the base letter is ASCII Latin, keeps both scripts correct.
   *
   * @param text - Lower-cased text.
   * @returns The text with Latin accents removed.
   */
  private static foldLatinAccents(text: string): string {
    return [...text]
      .map((char) => {
        const base = char.normalize('NFD')[0];

        return LATIN_BASE.test(base) ? base : char;
      })
      .join('');
  }
}
