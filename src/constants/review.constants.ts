import {
  ProducerIssueCode,
  ReviewIssueCode,
  ReviewIssueSeverity,
} from '~enums';

/**
 * How badly each code wants attention. Read by the SQL that ranks the queue
 * and by the client that colours the chips, so there is one answer.
 */
export const REVIEW_ISSUE_SEVERITY: Readonly<
  Record<ReviewIssueCode, ReviewIssueSeverity>
> = {
  [ReviewIssueCode.PRODUCER_REJECTED]: ReviewIssueSeverity.CRITICAL,
  [ReviewIssueCode.NO_PRODUCER]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.CYRILLIC_NAME]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.DUPLICATE]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.MISSING_ABV]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.MISSING_VOLUME]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.MISSING_COUNTRY]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.MISSING_TYPE]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.PRODUCER_WITHHELD]: ReviewIssueSeverity.ERROR,
  [ReviewIssueCode.TYPE_VS_NAME]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.COUNTRY_VS_NAME]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.ABV_RANGE]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.NAME_LEFTOVER]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.AGE_IN_RAW]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.UNTRUSTED_FACT]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.CONFLICT]: ReviewIssueSeverity.WARN,
  [ReviewIssueCode.AGE_SINGLE_STORE]: ReviewIssueSeverity.INFO,
  [ReviewIssueCode.NEW]: ReviewIssueSeverity.INFO,
};

/**
 * Severity as a sortable number, worst first. Lower sorts earlier, so the
 * queue's default `ORDER BY` is plain ascending.
 */
export const REVIEW_SEVERITY_RANK: Readonly<
  Record<ReviewIssueSeverity, number>
> = {
  [ReviewIssueSeverity.CRITICAL]: 0,
  [ReviewIssueSeverity.ERROR]: 1,
  [ReviewIssueSeverity.WARN]: 2,
  [ReviewIssueSeverity.INFO]: 3,
};

/**
 * How badly each producer code wants attention. Same vocabulary as the
 * bottlings queue, so one legend explains both tabs — and the same order the
 * producers query's own `CASE` ranks by.
 */
export const PRODUCER_ISSUE_SEVERITY: Readonly<
  Record<ProducerIssueCode, ReviewIssueSeverity>
> = {
  [ProducerIssueCode.NO_ALIAS]: ReviewIssueSeverity.ERROR,
  [ProducerIssueCode.ALIAS_UNREACHABLE]: ReviewIssueSeverity.ERROR,
  [ProducerIssueCode.UNLINKED_MENTIONS]: ReviewIssueSeverity.WARN,
  [ProducerIssueCode.KIND_SUSPECT]: ReviewIssueSeverity.WARN,
  [ProducerIssueCode.NO_REGION]: ReviewIssueSeverity.WARN,
  [ProducerIssueCode.UNVERIFIED]: ReviewIssueSeverity.INFO,
  [ProducerIssueCode.NO_DEFAULT_TYPE]: ReviewIssueSeverity.INFO,
  [ProducerIssueCode.BRAND_NO_PARENT]: ReviewIssueSeverity.INFO,
  [ProducerIssueCode.PEAT_UNKNOWN]: ReviewIssueSeverity.INFO,
};

/**
 * One whisky type and the words that state it in a product name.
 *
 * Keywords, not regexes, and that is the decision rather than a shortcut: the
 * detector runs in Postgres and its result is explained in TypeScript, and
 * POSIX and JavaScript regular expressions differ in exactly the places this
 * vocabulary needs — word boundaries around Cyrillic, lookahead syntax, case
 * folding. A shared keyword list is read identically by both, and the SQL is
 * generated from this table so the two cannot drift. That pairing is the
 * lesson `extractAgeYears` and `ProductNameUtils` already paid for.
 *
 * Every keyword is matched against a lower-cased haystack wrapped in single
 * spaces, so ` rye ` is a whole word and `rye` is a substring — the same
 * technique `TYPE_KEYWORDS` uses in the scrape pass.
 */
export interface ReviewTypePattern {
  /**
   * The `type.name` this vocabulary states.
   */
  type: string;

  /**
   * Any of these in the haystack claims the type.
   */
  match: readonly string[];

  /**
   * Any of these anywhere in the haystack withdraws the claim, because the
   * word is naming a cask rather than a category.
   */
  except: readonly string[];
}

/**
 * The type words a product name may state, in the order they are tested.
 *
 * Order is load-bearing for the same reason `TYPE_KEYWORDS` orders itself:
 * `single malt` contains `malt`, and `rye` heads both a category and a cask
 * qualifier. The first row that matches wins, so the specific claims come
 * before the general ones.
 *
 * The exclusions are evidence-driven. `bourbon` is a maturation word in this
 * catalogue far more often than a category word — `Glenmorangie The Lasanta
 * bourbon & sherry casks`, `1st fill bourbon hogshead`, `ex bourbon` — which
 * is the same lesson `ProductNameUtils` records about `Bushmills Bourbon
 * Finish`. Measured on the dump of 2026-09-17 this table fires on 61 stocked
 * bottlings, of which the two large buckets (19 rye-named bottlings stored as
 * bourbon, 15 single-malt-named stored as blend) are all genuine.
 */
export const REVIEW_TYPE_PATTERNS: readonly ReviewTypePattern[] = [
  {
    type: 'single malt',
    match: ['односолодов', 'single malt', 'single-malt'],
    except: [],
  },
  {
    type: 'tennessee',
    match: ['tennessee', 'теннессі', 'теннесі'],
    except: [],
  },
  {
    type: 'rye',
    match: ['житн', 'rye whisk', ' rye ', ' rye,'],
    except: ['rye cask', 'rye barrel', 'rye finish', 'rye hogshead'],
  },
  {
    type: 'bourbon',
    match: ['бурбон', 'bourbon whisk'],
    except: [
      'бурбонн',
      'бурбон бочк',
      'bourbon cask',
      'bourbon barrel',
      'bourbon barell',
      'bourbon finish',
      'bourbon hogshead',
    ],
  },
  {
    type: 'blend',
    match: ['купажован', 'blended whisk', ' бленд'],
    except: [],
  },
  {
    type: 'grain',
    match: ['зернов', 'single grain', 'grain whisk'],
    except: [],
  },
];

/**
 * Words that place a whisky in Scotland, in both scripts. `highland` is safe
 * to include because the detector only fires when the stored country is *not*
 * Scotland, so `Highland Park` — already Scottish — never reaches it.
 */
export const REVIEW_SCOTLAND_WORDS: readonly string[] = [
  'islay',
  'айла',
  'speyside',
  'спейсайд',
  'highland',
  'хайленд',
  'lowland',
  'лоуленд',
  'campbeltown',
  'кемпбелтаун',
];

/**
 * The ISO code a Scotch region word implies.
 */
export const REVIEW_SCOTLAND_CODE = 'GB-SCT';

/**
 * An age statement inside a shop's raw name, in the spellings the catalogue
 * uses. Deliberately looser than `extractAgeYears`, which decides what is
 * *stored*: this only asks whether some shop said an age the bottling does not
 * carry, and a person settles it.
 */
export const REVIEW_RAW_AGE_PATTERN =
  '(?<![0-9])[0-9]{1,3}\\s*(y\\.?o\\.?|yo|уо|years?|років|роки|рік|year)'
  + '(?![a-zа-яіїєґ])';

/**
 * Prose that states a minimum rather than an age statement — «витримка 4
 * роки», «від 3 років». A bottling whose only age wording is one of these is
 * not missing an age, so the detector leaves it alone.
 */
export const REVIEW_RAW_AGE_EXCEPT_PATTERN =
  '(витримк|від\\s+[0-9]|до\\s+[0-9])';

/**
 * Packaging the name cleaner should have removed and did not. Every one of
 * these was found in a canonical name in the catalogue.
 */
export const REVIEW_PACKAGING_WORDS: readonly string[] = [
  'під.',
  'кор.',
  'тубус',
  'набір',
  'склян',
  'бокал',
  'коробц',
  'подар',
];

/**
 * The strength band a whisky occupies. Outside it the bottling is a liqueur,
 * a ready-to-drink mix, or a misprint.
 */
export const REVIEW_ABV_MIN = 35;

/**
 * Upper bound of the whisky strength band; above it the value is a misprint
 * rather than a cask-strength bottling.
 */
export const REVIEW_ABV_MAX = 70;

/**
 * Share of a producer's bottlings that must be single malts before its
 * recorded `blend` kind is called into question.
 */
export const PRODUCER_KIND_SUSPECT_SHARE = 0.5;

/**
 * Default page size for every curation listing. The screen is a work queue,
 * not an export.
 */
export const REVIEW_PAGE_SIZE = 50;

/**
 * Largest page the curation screen may ask for.
 */
export const REVIEW_MAX_PER_PAGE = 200;

/**
 * Most bottlings one bulk write may carry — the screen's own page size, and
 * the bound of a request whose statements are applied one at a time.
 */
export const REVIEW_BULK_MAX = 200;

/**
 * How many producer candidates and duplicate candidates a suggestion read
 * offers. Beyond a handful the person is reading a list rather than choosing.
 */
export const REVIEW_SUGGESTION_LIMIT = 8;

/**
 * How many bottlings an impact preview names one by one. The counts are
 * always exact; the list is what fits on the screen beside them.
 */
export const REVIEW_AFFECTED_LIMIT = 50;

/**
 * Where the moment of the last knowledge-base pass is kept.
 *
 * On the **session** Valkey, not the cache one: the cache evicts under memory
 * pressure and this is a fact rather than a saved computation, and the session
 * instance is already where the fleet's coordination state lives. One key, no
 * expiry, written after every successful pass and read by the curation
 * screen's header.
 */
export const KB_APPLIED_AT_KEY = 'kb:applied-at';
