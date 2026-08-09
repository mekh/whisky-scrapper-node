/**
 * Cyrillic letter class, used in place of ASCII-only `\w` / `\b` (JS keeps
 * those ASCII even under the `u` flag). The lookarounds reproduce a word
 * boundary around a Cyrillic token.
 */
const CYRILLIC = 'а-яіїєґ';
const CYRILLIC_ANY = 'а-яіїєґА-ЯІЇЄҐ';
const NOT_LETTER_AFTER = `(?![a-z${CYRILLIC}])`;
const NOT_LETTER_BEFORE = `(?<![a-z${CYRILLIC}])`;

/**
 * Latin / Cyrillic letter pairs that render identically. Several stores type a
 * word in one script with a stray letter from the other (`Вiскi` with Latin
 * `i`, `MaсArthur's` with Cyrillic `с`), which both breaks the rules below and
 * makes the very same product two different strings.
 */
const CONFUSABLES: [string, string][] = [
  ['a', 'а'],
  ['c', 'с'],
  ['e', 'е'],
  ['i', 'і'],
  ['o', 'о'],
  ['p', 'р'],
  ['x', 'х'],
  ['y', 'у'],
  ['A', 'А'],
  ['B', 'В'],
  ['C', 'С'],
  ['E', 'Е'],
  ['H', 'Н'],
  ['I', 'І'],
  ['K', 'К'],
  ['M', 'М'],
  ['O', 'О'],
  ['P', 'Р'],
  ['T', 'Т'],
  ['X', 'Х'],
  ['Y', 'У'],
];

const TO_LATIN = new Map(CONFUSABLES.map(([latin, cyr]) => [cyr, latin]));
const TO_CYRILLIC = new Map(CONFUSABLES);

/**
 * A run of letters, i.e. one word for the purpose of script detection.
 */
const WORD = new RegExp(`[A-Za-z${CYRILLIC_ANY}]+`, 'g');
const LATIN_LETTER = /[A-Za-z]/;

/**
 * Any letter. Not the `WORD` pattern, which is global and would carry
 * `lastIndex` between `test` calls.
 */
const HAS_LETTER = new RegExp(`[A-Za-z${CYRILLIC_ANY}]`);

/**
 * Separator of the dual name several stores emit: the Cyrillic
 * transliteration on one side, the Latin original on the other
 * (`Віскі Крагганмор / Cragganmore`, `Dewar's White Label / Дьюарс Уайт
 * Лейбл`). Spaces are required so a vintage range (`2011/2012`) and a
 * mistyped volume (`0/7 л`) are not split.
 */
const DUAL_SEPARATOR = ' / ';

/**
 * Leading category/marketing prefix: the run of characters before the first
 * Latin letter or digit (`Віскі `, `Набір: віскі `, etc.).
 */
const LEADING_PREFIX = /^[^0-9A-Za-z]+/;

/**
 * Store product code in parentheses (Rozetka / MauDau / Auchan), e.g.
 * `(142828)`, `(Q5225)`, `(3800032010292B)`, `(5010103917803_ 5055966820037)`,
 * `(5011166068815Н)`: upper-case letters of either alphabet, digits and
 * separators, with at least four digits. Not anchored to the end — several
 * stores put the code before the packaging note.
 *
 * The four-digit floor plus the year guard keep `(NAS)`, `(Peated)`, `(0.7)`,
 * `(Batch 10)` and a vintage `(1968)`.
 */
const PRODUCT_CODE = new RegExp(
  '\\s*\\((?!(?:19|20)\\d{2}\\))(?=(?:[^)\\d]*\\d){4})'
    + '[A-ZА-ЯІЇЄҐ0-9_/+\\-.\\s]+\\)',
  'g',
);

/**
 * Accessories a bundle throws in with the bottle: glassware, a hip flask, a
 * bar spoon, coffee, a mixer. The bottle is the product; the accessory is a
 * promotion, and keeping it made one bottling render as half a dozen names.
 */
const ACCESSORY = '(?:келих|склянк|стакан|чарк|бокал|фляг|тумблер|костер'
  + '|ложк|джигер|підставк|гойдалк|кав[аиуі]|набір\\s+склянок'
  + '|glass|glasses|tumbler|coffee|cola)';
const ACCESSORY_TEST = new RegExp(
  `${NOT_LETTER_BEFORE}${ACCESSORY}`,
  'i',
);

/**
 * A count preceding an accessory, as a digit (`2`, `2-ма`) or spelled out
 * (`двома`).
 */
const ACCESSORY_COUNT = '(?:\\d+\\s*[-–‑]?\\s*(?:ма|ми|х)?\\s+'
  + `|(?:одн|дв|тр|чотир|п['’]ят)[${CYRILLIC}']*\\s+)`;

/**
 * Accessory joined with a preposition or conjunction rather than a `+`
 * (`з 2 келихами`, `з двома склянками`, `та 2 стакани`).
 */
const WITH_ACCESSORY = new RegExp(
  `\\s+(?:з|із|с|та)\\s+(?:${ACCESSORY_COUNT})?${ACCESSORY}[${CYRILLIC}]*.*$`,
  'i',
);

/**
 * Multipack count (`(x 12 шт.)`, `х 6 шт`, `(2 шт. х)`). The pack size lives
 * in `volumeMl`, which is what keeps a 12-bottle case from being compared
 * against a single bottle.
 */
const MULTIPACK = [
  /\s*\(\s*\d+(?:[.,]\d+)?\s*(?:л|l|мл|ml)?\s*[xх]\s*\d+\s*(?:шт\.?)?\s*\)/gi,
  /\s*\(\s*\d+\s*шт\.?\s*[xх]\s*\d+(?:[.,]\d+)?\s*(?:л|l|мл|ml)?\s*\)/gi,
  /\s*\(?\s*(?:[xх]\s*)?\d+\s*шт\.?\s*(?:[xх]\s*)?\)?/gi,
  /\s*\(\s*[xх]\s*\d+\s*\)/gi,
  /\s+\d+\s*[xх]\s*$/gi,
];

/**
 * Age number: an integer or a decimal (`2.5 роки`).
 */
const AGE_NUMBER = '\\d+(?:[.,]\\d+)?';

/**
 * Age statement, Latin spelling (`12yo`, `12 Y.O.`, `12YO`). The trailing
 * guard stops it matching inside a word such as `young`.
 */
const AGE_YO = new RegExp(
  `${AGE_NUMBER}\\s*y\\.?o\\.?${NOT_LETTER_AFTER}`,
  'gi',
);

/**
 * Age statement, Cyrillic transliteration of `yo` (`3 уо`, `12УО`), which
 * several stores emit instead of the Latin form.
 */
const AGE_YO_CYRILLIC = new RegExp(
  `${AGE_NUMBER}\\s*уо${NOT_LETTER_AFTER}`,
  'gi',
);

/**
 * Age statement, word spelling (`3 роки витримки`, `4 Year Old`, `12 років`,
 * `14 years old`, the Russian `11 лет`). The guard stops a match inside a
 * word (`yearly`).
 */
const AGE_WORDS = new RegExp(
  `${AGE_NUMBER}\\s*(?:рік|роки|років|лет|года|год|years?)`
    + `${NOT_LETTER_AFTER}(?:\\s+(?:витримки|old))?`,
  'gi',
);

/**
 * Age given as a range in Ukrainian (`від 6-ти до 8-ми років`). Consumed
 * whole so neither bound stays behind. The opening `від` is required: without
 * it the leading number is part of the name, as in `Wild Turkey 81 до 8 років
 * витримки`, where only `8 років витримки` is the age.
 */
const AGE_RANGE = new RegExp(
  'від\\s+\\d+\\s*[-–‑]?\\s*(?:ти|ми|ох|х)?\\s+до\\s+'
    + '\\d+\\s*[-–‑]?\\s*(?:ти|ми|ох|х)?\\s+рок(?:ів|и|у)',
  'gi',
);

/**
 * Words that introduce the age without a number of their own
 * (`витримка 10 років`, `витриманий 12 років`), left behind once the number
 * itself is stripped.
 */
const AGING = new RegExp(
  `(?:витримк[${CYRILLIC}]*|витриман[${CYRILLIC}]*|витрим\\.)`,
  'gi',
);

/**
 * A one- or two-digit age written bare, recognisable only because the
 * Cyrillic category word follows it — the signature of the stores that list
 * `Aberlour 12 віскі односолодовий 0.7л`. Restricted to two digits so a
 * vintage (`Islay Barley 2012 віскі`) and an edition number after a dot
 * (`Black Art 9.1`) are kept, and to the Cyrillic spelling because a number
 * before the Latin category word is part of the name
 * (`Label 5 Bourbon Barrel`).
 */
const BARE_AGE = new RegExp(
  `(?<=\\s)\\d{1,2}(?=\\s+(?:віскі|віски|бурбон)${NOT_LETTER_AFTER})`,
  'gi',
);

/**
 * ABV percentage (`40%`, `46,3 %`, `41,15%`) including a cask-strength range
 * (`48-65%`), which must be consumed whole so its lower bound does not stay
 * behind. Discount prefixes are handled by the replace callback, not by the
 * pattern, so `-25%` survives.
 */
const ABV_NUMBER = '\\d{1,3}(?:[.,]\\d{1,2})?';
const ABV = new RegExp(
  `${ABV_NUMBER}(?:\\s*[-–—]\\s*${ABV_NUMBER})?\\s*%`,
  'g',
);

/**
 * Characters that mark the number as a discount rather than an ABV. Mirrors
 * `DISCOUNT_PREFIXES` in `scrape/normalize/normalize.service.ts`.
 */
const DISCOUNT_PREFIXES = '-−–';

/**
 * Bottle volume in millilitres / litres (`0,7л`, `0.7 л`, `700 мл`, `1 l`).
 * `/` is accepted as a decimal separator because stores mistype it (`0/7 л`).
 * Deliberately duplicated from `scrape/normalize/normalize.service.ts`:
 * that module extracts the value into a column, this one deletes the token
 * from the display name, and `~utils` is a leaf layer that must not import
 * from `scrape/`.
 */
const VOLUME_ML = new RegExp(
  `\\d{2,4}\\s*(?:мл|ml)${NOT_LETTER_AFTER}`,
  'gi',
);
const VOLUME_L = new RegExp(
  `\\d+(?:[.,/]\\d+)?\\s*(?:літр|л|l)${NOT_LETTER_AFTER}`,
  'gi',
);

/**
 * Adjectives and nouns that name the packaging (`в подарунковій коробці`,
 * `у сувенірному пакуванні`, `в тубусі`, `gift box`, `Tube`). They describe
 * the box, not the bottle, so they are dropped from the product name.
 */
const PACK_ADJECTIVE = "(?:подарунков|сувенірн|дерев['’]?ян|металев|картонн"
  + `|пластиков|фірмов|святков|оригінальн|престижн)[${CYRILLIC}]*`;
const PACK_NOUN = '(?:коробц|коробк|упаковц|упаковк|пак(?:уванн|ован)'
  + `|туб|футляр|бляшанц|бляшанк|набір|набор)[${CYRILLIC}]*`;
const PACKAGING = new RegExp(
  NOT_LETTER_BEFORE
    + '(?:'
    + `(?:(?:в|у|во)\\s+)?(?:${PACK_ADJECTIVE}\\s+)?${PACK_NOUN}`
    + '|gift\\s*(?:box|tube|pack|set)|wooden\\s+box|metal\\s+(?:box|tin)'
    + '|tube|tin\\s+box'
    + ')'
    + NOT_LETTER_AFTER,
  'gi',
);

/**
 * Retail boilerplate about the label rather than the drink
 * (`дизайн етикетки в асортименті`).
 */
const ASSORTMENT = /(?:дизайн\s+етикетки\s+)?в\s+асортименті/gi;

/**
 * A store's internal de-duplication marker, leaked into the title itself
 * (`Old Malt Cask_dupHzEU Auchentoshan`).
 */
const DUP_MARKER = /_dup[A-Za-z0-9]+/g;

/**
 * A bare one- or two-digit number in brackets, which is a listing artefact
 * rather than part of the name (`Jameson Triple Triple (6)`, `Midleton Very
 * Rare 40th Anniversary (1)`).
 */
const PAREN_NUMBER = /\s*\(\s*\d{1,2}\s*\)/g;

/**
 * Parentheses left empty once their contents were stripped.
 */
const EMPTY_PARENS = /\(\s*\)/g;

/**
 * Separator run left directly inside a parenthesis by a stripped token, e.g.
 * the `(0.7 л x 12 шт.)` of a multipack becoming `( x 12 шт.)`.
 */
const PAREN_EDGE = /\(\s*[,;\-–—\s]*|[,;\-–—\s]*\)/g;

/**
 * A run of whitespace and commas containing at least one comma. Collapsed to a
 * single space, not to a comma: the comma is a source-formatting artefact (OK
 * Wine and Goodwine write `Brand, Expression`, the supermarkets write
 * `Brand Expression`), and keeping it made the very same bottling render two
 * ways depending on which store it came from.
 */
const COMMA_RUN = /(?:\s*,\s*)+/g;

/**
 * Typographic apostrophes and quotes, folded onto the ASCII apostrophe so
 * `Bell’s` and `Bell's` cannot both exist as separate display names.
 */
const APOSTROPHES = /[‘’ʼ`´]/g;

/**
 * Quotation marks around an expression name (`Dalmore "Cigar Malt"`). Stores
 * disagree on whether to quote, so the marks are dropped rather than becoming
 * a second spelling of the same product.
 */
const QUOTES = /["«»“”„]/g;

/**
 * A Ukrainian preposition or conjunction left dangling at the end once the
 * clause it introduced was stripped (`Dewar's White Label від`).
 */
const DANGLING = new RegExp(
  '\\s+(?:від|в|у|з|із|с|та|на|до|по)$',
  'i',
);

/**
 * Words that turn `bourbon` into part of the expression: a `Bourbon Finish`
 * or a `Bourbon Cask` names the maturation, not the category, and dropping
 * the qualifier's head word made `Bushmills Bourbon Finish` collide with
 * `Bushmills Rum Finish`.
 *
 * Only `bourbon` earns the guard. Extending it to the other category words
 * protected phrases that really are categories — `Penelope Whiskey Barrel
 * Strength`, a leading `Whisky Oak & Palomino`.
 */
const CASK_QUALIFIER = '(?!\\s+(?:finish|cask|casks|barrel|barrels|butt'
  + '|butts|hogshead|hogsheads|puncheon|wood|oak|matured|maturation))';

/**
 * The category words the cask guard applies to.
 */
const CASK_HEADS = new Set(['bourbon', 'бурбон']);

/**
 * Whisky category words. Never part of a brand, so they are dropped wherever
 * they appear — including the first word, because several stores prefix the
 * category twice ("Бурбон Bourbon Eagle Rare"), and a first-word exemption
 * left the duplicate behind. `stripDescriptors` restores the input when the
 * strip would leave nothing at all, which is what protects a name made of
 * category words only.
 *
 * Ordered longest-first so `single malt` is consumed before `malt`. Cyrillic
 * entries carry a stem class because the adjective is declined
 * (`односолодовий`, `односолодове`, `односолодового`).
 */
const CATEGORY_WORDS = [
  'kentucky straight bourbon whiskey',
  'kentucky straight bourbon',
  'kentucky straight',
  'tennessee whiskey',
  'blended scotch whisky',
  'blended malt scotch whisky',
  'single malt scotch whisky',
  'straight bourbon whiskey',
  'straight rye whiskey',
  'single pot still',
  'blended scotch',
  'single malt',
  'single grain',
  'blended malt',
  'blended grain',
  'straight bourbon',
  'straight rye',
  'rye whiskey',
  'rye whisky',
  'pure malt',
  'scotch whisky',
  'scotch',
  'blended',
  'bourbon',
  'whiskey',
  'whisky',
  'віскі',
  'віски',
  `односолодов[${CYRILLIC}]*`,
  `купажован[${CYRILLIC}]*`,
  `солодов[${CYRILLIC}]*`,
  `однозернов[${CYRILLIC}]*`,
  `зернов[${CYRILLIC}]*`,
  `житн[${CYRILLIC}]*`,
  `бленд[${CYRILLIC}]*`,
  'бурбон',
];

/**
 * Nationality words, stripped **only at the very end of the name**, where
 * they can only be a provenance tag (`Aber Falls Welsh`). Regions
 * (`Islay`, `Highland`, `Speyside`, `Campbeltown`) are deliberately absent:
 * in this catalogue they are almost always the name itself — `Highland Park`,
 * `Highland Mist`, `Islay Barley`, `Campbeltown Harbour` — and
 * `Clan Denny Islay` is a different whisky from `Clan Denny Speyside`.
 */
const ORIGIN_WORDS = [
  'welsh',
  'irish',
  'scottish',
  'japanese',
  'canadian',
  'indian',
  'american',
];

/**
 * The same tags in Cyrillic. These are stripped wherever they sit: a Cyrillic
 * nationality adjective is never part of a Latin brand or expression, so the
 * end-of-name restriction that protects `Wild Turkey American Honey` is not
 * needed for `Chivas Regal шотландське LE`.
 */
const ORIGIN_WORDS_CYRILLIC = [
  `шотландськ[${CYRILLIC}]*`,
  `ірландськ[${CYRILLIC}]*`,
  `американськ[${CYRILLIC}]*`,
  `японськ[${CYRILLIC}]*`,
  `індійськ[${CYRILLIC}]*`,
  `канадськ[${CYRILLIC}]*`,
  `уельс[${CYRILLIC}]*`,
];

/**
 * Country of origin in brackets, as OK Wine tags the non-Scottish bottlings
 * (`Bouteille Double Cask (Франція)`).
 */
const COUNTRIES = 'Франція|Шотландія|Ірландія|Словаччина|Іспанія|Японія'
  + '|Індія|Канада|США|Англія|Німеччина|Італія|Польща|Уельс';
const PAREN_COUNTRY = new RegExp(`\\s*\\(\\s*(?:${COUNTRIES})\\s*\\)`, 'g');

/**
 * Builds a matcher for one descriptor phrase, with Cyrillic-safe word
 * boundaries and an optional anchor to the end of the string.
 *
 * @param phrase - The phrase to match; may contain a character class.
 * @param atEnd - Whether the phrase must end the name.
 * @returns The compiled pattern.
 */
function descriptor(phrase: string, atEnd: boolean): RegExp {
  const body = phrase.replace(/ /g, '\\s+');
  const guard = CASK_HEADS.has(phrase) ? CASK_QUALIFIER : '';
  const tail = atEnd ? '\\s*$' : guard;

  return new RegExp(
    `${NOT_LETTER_BEFORE}${body}${NOT_LETTER_AFTER}${tail}`,
    'gi',
  );
}

const CATEGORY_PATTERNS = [
  ...CATEGORY_WORDS,
  ...ORIGIN_WORDS_CYRILLIC,
].map((w) => descriptor(w, false));
const ORIGIN_PATTERNS = ORIGIN_WORDS.map((w) => descriptor(w, true));

/**
 * Category and origin words wherever they sit, used only to weigh the two
 * sides of a dual name: `Віскі Jameson / Джемесон` is one Latin word against
 * one Cyrillic word until the category prefix stops being counted.
 */
const DESCRIPTOR_PATTERNS = [
  ...CATEGORY_WORDS,
  ...ORIGIN_WORDS,
  ...ORIGIN_WORDS_CYRILLIC,
].map((w) => descriptor(w, false));

/**
 * Separator characters that must not start or end a name.
 */
const EDGE_SEPARATORS = /^[\s,;./\-–—+]+|[\s,;./\-–—+]+$/g;

/**
 * Upper bound on the strip passes, a guard against a rule pair that could
 * bounce a name between two forms. In this catalogue the longest name needs
 * three passes.
 */
const MAX_STRIP_PASSES = 6;

/**
 * Words that may be a provenance or category tag when they end a name, but
 * are just as often the name itself (`Highland Park`, `Islay Mist`,
 * `Clan Denny Islay`, the `North British` distillery). Nothing here can be
 * stripped on sight — the caller has to hold the whole catalogue and check
 * that the shorter name is one a store actually used, which is what separates
 * `Bankhall British` → `Bankhall` from `North British`, where no bare `North`
 * exists. See `collapseTags` in `scripts/clean-product-names.ts`.
 */
export const NAME_TAG_WORDS: ReadonlySet<string> = new Set([
  'islay',
  'speyside',
  'highland',
  'highlands',
  'lowland',
  'lowlands',
  'campbeltown',
  'island',
  'islands',
  'welsh',
  'irish',
  'scotch',
  'scottish',
  'japanese',
  'canadian',
  'indian',
  'american',
  'english',
  'british',
  'swedish',
  'taiwanese',
  'german',
  'french',
  'australian',
  'finnish',
  'whisky',
  'whiskey',
  'bourbon',
  'blended',
  'malt',
  'grain',
  'single',
  'straight',
  'rye',
  'pure',
]);

/**
 * Product-name helpers shared by the scraper import and name-cleanup tooling.
 */
export class ProductNameUtils {
  /**
   * Cleans a scraped product name down to the product itself: folds the
   * mixed-script spellings, picks the Latin side of a dual name, drops the
   * leading category prefix, the trailing store product code, every age /
   * ABV / volume token, and the packaging and bundle descriptors. Age, ABV and
   * volume are stored in their own columns and re-composed by the frontend, so
   * keeping them in the name would duplicate them.
   *
   * This is the deterministic pass. It cannot tell a type/region descriptor
   * (`Single Malt`, `Welsh`) from part of a brand (`Highland Park`), so
   * `LlmNameExtractionService` produces the brand+expression name when the
   * LLM is configured and this method is the fallback.
   *
   * @param raw - The raw product name as scraped.
   * @returns The cleaned name, or `null` when nothing meaningful remains
   *   (e.g. a bare `Віскі` with no brand at all).
   */
  public static clean(raw: string): string | null {
    const folded = ProductNameUtils.foldScripts(raw)
      .replace(APOSTROPHES, "'");

    return ProductNameUtils.stripSpecs(
      ProductNameUtils.pickDual(folded)
        .replace(LEADING_PREFIX, '')
        .replace(PRODUCT_CODE, ''),
    );
  }

  /**
   * Removes the age / ABV / volume / packaging / bundle tokens and repairs the
   * punctuation they leave behind, without touching a leading category
   * prefix. Applied to a name that is already the product itself — an
   * LLM-extracted one, which may legitimately be all-Cyrillic and would be
   * wiped out by the prefix rule `clean` applies to raw scraped text.
   *
   * @param text - The name to strip.
   * @returns The stripped name, or `null` when nothing remains.
   */
  public static stripSpecs(text: string): string | null {
    /**
     * Repeated to a fixed point, because a token can only be recognised once
     * the one beside it is gone: two origin tags in a row leave the inner one
     * behind (`The Quiet Man Irish American` → `… Irish`), and a multipack
     * count reaches the end of the string only after the volume goes
     * (`Glenfiddich Mix Pack 3х 0.7 л`). The fixed point is also what makes
     * the pass idempotent, which matters because it runs over its own output:
     * on the LLM's answer, and again on every re-run of the backfill.
     */
    let cleaned = text;

    for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
      const next = ProductNameUtils.stripOnce(cleaned);

      if (next === cleaned) {
        break;
      }

      cleaned = next;
    }

    return cleaned.length > 0 ? cleaned : null;
  }

  /**
   * One pass of the spec strip.
   *
   * @param text - The name to strip.
   * @returns The stripped and tidied name, possibly empty.
   */
  private static stripOnce(text: string): string {
    /**
     * The dual-name rule runs here too, not only in `clean`: the model
     * sometimes echoes the separator it was told to resolve, and
     * `Aberlour / Double Cask` would otherwise stand beside
     * `Aberlour Double Cask` as a second product.
     */
    const bundled = ProductNameUtils.stripBundle(
      ProductNameUtils.pickDual(
        ProductNameUtils.foldScripts(text)
          .replace(APOSTROPHES, "'")
          .replace(QUOTES, ' ')
          .replace(DUP_MARKER, '')
          .replace(PRODUCT_CODE, ''),
      ),
    );

    /**
     * The multipack goes before the volume: its own patterns consume the
     * bottle size inside the brackets, so nothing is left to strand a `(`.
     */
    const unpacked = MULTIPACK.reduce(
      (acc, pattern) => acc.replace(pattern, ' '),
      bundled,
    );

    const stripped = unpacked
      .replace(AGE_RANGE, '')
      .replace(AGE_YO, '')
      .replace(AGE_YO_CYRILLIC, '')
      .replace(AGE_WORDS, '')
      .replace(BARE_AGE, '')
      .replace(AGING, '')
      .replace(VOLUME_ML, '')
      .replace(VOLUME_L, '')
      .replace(PACKAGING, '')
      .replace(ASSORTMENT, '')
      .replace(PAREN_NUMBER, '')
      .replace(PAREN_COUNTRY, '');

    return ProductNameUtils.dropRepeats(
      ProductNameUtils.tidy(
        ProductNameUtils.stripDescriptors(
          ProductNameUtils.stripAbv(stripped),
        ),
      ),
    );
  }

  /**
   * Drops a phrase the source listed twice in a row: the bottler typed twice
   * over (`Wilson & Morgan Wilson & Morgan Beathan Oloroso Finish`,
   * `The Kinship The Kinship Caol Ila`) or a vintage repeated
   * (`Scyfion Aultmore 2006 2006`).
   *
   * Deliberately narrow, because a repeat is often the product itself:
   *
   * - a run of **one** word only collapses when it is a number, so
   *   `Jameson Triple Triple` survives;
   * - a run holding a `+` never collapses, because that is a gift set named
   *   after each of its bottles (`Jura Journey + Jura + Jura`);
   * - only an **adjacent** repeat collapses. Matching a leading phrase against
   *   the trailing one as well cost `Jack Daniel's Gentleman Jack` its `Jack`
   *   and `Monkey Shoulder Smokey Monkey` its `Monkey`, to save two rows whose
   *   title opens and closes with `Old Malt Cask`.
   *
   * @param text - The tidied name.
   * @returns The name with the duplicated phrase dropped.
   */
  private static dropRepeats(text: string): string {
    let words = text.split(' ');

    for (let start = 0; start < words.length;) {
      const length = ProductNameUtils.repeatLength(words, start);

      if (length === 0) {
        start += 1;
        continue;
      }

      words = [
        ...words.slice(0, start + length),
        ...words.slice(start + length * 2),
      ];
    }

    return words.join(' ');
  }

  /**
   * Length of the word run at `start` that the run right after it repeats.
   *
   * @param words - The name's words.
   * @param start - Where the run starts.
   * @returns The run length, longest first, or 0 when nothing repeats.
   */
  private static repeatLength(words: string[], start: number): number {
    const most = Math.floor((words.length - start) / 2);

    for (let length = most; length > 0; length -= 1) {
      const first = words.slice(start, start + length);
      const second = words.slice(start + length, start + length * 2);

      if (
        !ProductNameUtils.sameWords(first, second)
        || first.some((word) => word.includes('+'))
        || (length === 1 && !/^\d+$/.test(first[0]))
      ) {
        continue;
      }

      return length;
    }

    return 0;
  }

  /**
   * Compares two word runs, ignoring case.
   *
   * @param first - The first run.
   * @param second - The second run.
   * @returns True when they are the same words.
   */
  private static sameWords(first: string[], second: string[]): boolean {
    return first.length === second.length
      && first.every((word, at) =>
        word.toLowerCase() === second[at].toLowerCase()
      );
  }

  /**
   * Drops from an already-extracted name any bare number the raw name states
   * as an age or an ABV. This is the one spec token no pattern can recognise
   * on its own — `Balblair 21` and `Maker's Mark 46` are the same shape — and
   * the raw name is the evidence that decides: `Віскі Balblair 21 рік` states
   * 21 as an age, while `Maker's Mark 46 0.7 л 47%` never states 46 at all.
   *
   * @param name - The extracted name.
   * @param raw - The raw scraped name it was extracted from.
   * @returns The name without the redundant numbers.
   */
  public static dropSpecNumbers(name: string, raw: string): string {
    const stated = ProductNameUtils.statedNumbers(raw);

    if (!stated.size) {
      return name;
    }

    const stripped = name.replace(
      /(?<![\d.,/№#-])\d+(?:[.,]\d+)?(?![\d.,/%-])/g,
      (match) => (stated.has(match.replace(',', '.')) ? ' ' : match),
    );

    const tidied = ProductNameUtils.tidy(stripped);

    return tidied.length > 0 ? tidied : name;
  }

  /**
   * Whether a raw name joins several bottles with a `+` — a gift set rather
   * than a bottle with a glass thrown in.
   *
   * A set is its own product at its own price, and its `volumeMl` is often the
   * single-bottle size, so dropping the other bottles from the name leaves a
   * three-bottle price sitting next to single bottles. Token validation cannot
   * catch that: the truncated name's every word does occur in the raw one.
   *
   * @param raw - The raw scraped name.
   * @returns True when a bottle-joining `+` survives the accessory strip.
   */
  public static hasBundle(raw: string): boolean {
    return ProductNameUtils.bundleSegments(raw) !== null;
  }

  /**
   * Splits a gift set's raw name into one segment per bottle, so a caller can
   * read each bottle's own specs — the set's volume is the sum, and taking the
   * first match recorded a three-bottle set as 0.7 л.
   *
   * The product code is dropped first: several codes are themselves joined with
   * `+` (`(5013967012462+5013967012509)`).
   *
   * @param raw - The raw scraped name.
   * @returns One segment per bottle, or null when this is not a set.
   */
  public static bundleSegments(raw: string): string[] | null {
    const bottles = ProductNameUtils.stripBundle(
      ProductNameUtils.foldScripts(raw).replace(PRODUCT_CODE, ''),
    );

    if (!bottles.includes('+')) {
      return null;
    }

    const segments = bottles.split('+').map((segment) => segment.trim())
      .filter(Boolean);

    return segments.length > 1 ? segments : null;
  }

  /**
   * Collects the numbers a raw name states as an age or an ABV.
   *
   * @param raw - The raw scraped name.
   * @returns The stated numbers, normalised to a dot decimal separator.
   */
  private static statedNumbers(raw: string): Set<string> {
    const found = new Set<string>();
    const patterns = [AGE_YO, AGE_YO_CYRILLIC, AGE_WORDS, ABV];

    for (const pattern of patterns) {
      for (const match of raw.matchAll(pattern)) {
        for (const number of match[0].match(/\d+(?:[.,]\d+)?/g) ?? []) {
          found.add(number.replace(',', '.'));
        }
      }
    }

    return found;
  }

  /**
   * Folds a stray letter borrowed from the other alphabet back into the script
   * its word is written in. Applied only when every minority letter has a
   * look-alike, so `ВіскіOld` — a missing space, not a typo — is left for the
   * prefix rule to split.
   *
   * @param text - The text to fold.
   * @returns The text with each word in a single script.
   */
  private static foldScripts(text: string): string {
    return text.replace(WORD, (word) => {
      const letters = [...word];
      const latin = letters.filter((ch) => LATIN_LETTER.test(ch)).length;
      const cyrillic = letters.length - latin;

      if (!latin || !cyrillic || latin === cyrillic) {
        return word;
      }

      const map = latin > cyrillic ? TO_LATIN : TO_CYRILLIC;
      const foldable = letters.every((ch) =>
        LATIN_LETTER.test(ch) === (latin > cyrillic) || map.has(ch)
      );

      return foldable
        ? letters.map((ch) => map.get(ch) ?? ch).join('')
        : word;
    });
  }

  /**
   * Resolves the dual name some stores emit: when one side is Cyrillic and
   * the other Latin, the Latin side is the product's own spelling. When both
   * sides are the same script the slash is not a dual name but a separator
   * (`Aberlour 16 yo / Double Cask, Tube`), so the sides are joined.
   *
   * @param text - The name, possibly carrying a dual form.
   * @returns The single-name form.
   */
  private static pickDual(text: string): string {
    const parts = text.split(DUAL_SEPARATOR);

    if (parts.length !== 2) {
      return parts.join(' ');
    }

    const [left, right] = parts;
    const leftLatin = ProductNameUtils.isLatinSide(left);
    const rightLatin = ProductNameUtils.isLatinSide(right);

    if (leftLatin === rightLatin) {
      return `${left} ${right}`;
    }

    return leftLatin ? left : right;
  }

  /**
   * Whether a side of a dual name is the Latin original rather than the
   * Cyrillic transliteration.
   *
   * Counted in whole words, and with the specs and descriptors removed
   * first. Counting letters instead let a Roman numeral inside the
   * transliteration (`Блю Лейбл Кінг Джордж V`) pass for Latin, and leaving
   * the specs and the category prefix in let them outweigh a short Latin
   * brand (`Віскі Боумор №1 / Bowmore №1, 40%, 0.7л, в коробці`).
   *
   * @param text - One side of the dual name.
   * @returns True when Latin words outnumber Cyrillic ones.
   */
  private static isLatinSide(text: string): boolean {
    const bare = DESCRIPTOR_PATTERNS.reduce(
      (acc, pattern) => acc.replace(pattern, ' '),
      text,
    );

    const words = bare
      .replace(ABV, ' ')
      .replace(VOLUME_ML, ' ')
      .replace(VOLUME_L, ' ')
      .replace(PACKAGING, ' ')
      .match(WORD) ?? [];

    const latin = words.filter((word) => LATIN_LETTER.test(word)).length;

    return latin > words.length - latin;
  }

  /**
   * Drops a bundled accessory (`+ 2 склянки`, `з 2-ма келихами`,
   * `+ фляга`). A `+` that introduces another bottle instead is kept: a
   * three-bottle gift set is its own product, and truncating it to the first
   * bottle would put a set's price next to a single bottle's.
   *
   * @param text - The name, possibly carrying a bundle clause.
   * @returns The name without the accessory clause.
   */
  private static stripBundle(text: string): string {
    const segments = text.split('+');
    const at = segments.findIndex(
      (segment, index) => index > 0 && ACCESSORY_TEST.test(segment),
    );

    const bottle = at > 0 ? segments.slice(0, at).join('+') : text;

    return bottle.replace(WITH_ACCESSORY, '');
  }

  /**
   * Drops whisky category words and a trailing nationality tag, so the same
   * bottling cannot render as `Aber Falls`, `Aber Falls Welsh` and `Aber Falls
   * Single Malt Welsh Whisky` depending on which store listed it. Applied to
   * both the deterministic pass and the LLM's answer, which makes the result
   * identical whichever produced it.
   *
   * A category word that heads a cask qualifier (`Bourbon Finish`) is kept,
   * and the input is restored when the strip leaves no letter behind — the
   * case where the descriptors were the whole name, whether that leaves
   * nothing at all or a bare reference (`Blended Malt #3` → `#3`).
   *
   * @param text - The name with the specs already stripped.
   * @returns The name without its descriptors.
   */
  private static stripDescriptors(text: string): string {
    const categories = CATEGORY_PATTERNS.reduce(
      (acc, pattern) => acc.replace(pattern, ' '),
      text,
    );

    const stripped = ORIGIN_PATTERNS.reduce(
      (acc, pattern) => acc.replace(pattern, ' '),
      ProductNameUtils.tidy(categories),
    );

    return HAS_LETTER.test(ProductNameUtils.tidy(stripped)) ? stripped : text;
  }

  /**
   * Removes ABV tokens, keeping the ones that are discount labels (`-25%`).
   *
   * @param text - The name with the other tokens already stripped.
   * @returns The name without its ABV tokens.
   */
  private static stripAbv(text: string): string {
    return text.replace(ABV, (match, offset: number, full: string) => {
      const isDiscount = offset > 0
        && DISCOUNT_PREFIXES.includes(full[offset - 1]);

      return isDiscount ? match : '';
    });
  }

  /**
   * Drops a bracket whose partner a stripped token took with it, e.g. the
   * `(` of `(0.7 л x 12 шт.)` once the volume and the count are gone.
   *
   * @param text - The name to balance.
   * @returns The name with only matched brackets left.
   */
  private static balanceParens(text: string): string {
    let depth = 0;
    const opened = [...text].filter((ch) => {
      if (ch === '(') {
        depth += 1;

        return true;
      }

      if (ch !== ')') {
        return true;
      }

      if (depth === 0) {
        return false;
      }

      depth -= 1;

      return true;
    });

    let extra = depth;

    return opened
      .reverse()
      .filter((ch) => !(ch === '(' && extra > 0 && extra--))
      .reverse()
      .join('');
  }

  /**
   * Repairs the punctuation the removed tokens left behind: empty
   * parentheses, repeated commas, doubled spaces, dangling separators and a
   * preposition whose object is gone.
   *
   * @param text - The name with every token already stripped.
   * @returns The tidied name, possibly empty.
   */
  private static tidy(text: string): string {
    let tidied = ProductNameUtils.balanceParens(
      text
        .replace(/\s+/g, ' ')
        .replace(PAREN_EDGE, (match) => (match.startsWith('(') ? '(' : ')'))
        .replace(EMPTY_PARENS, ''),
    )
      .replace(COMMA_RUN, ' ')
      .replace(EDGE_SEPARATORS, '')
      .trim();

    for (let previous = ''; previous !== tidied;) {
      previous = tidied;
      tidied = tidied.replace(DANGLING, '').replace(EDGE_SEPARATORS, '');
    }

    return tidied;
  }
}
