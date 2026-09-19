/**
 * Why a bottling is in the curation queue.
 *
 * A row carries every code that fires, so the table can say *why* without
 * anybody opening anything, and the same codes are what the «Проблеми» filter
 * selects by. Both come from one SQL fragment (`REVIEW_ISSUES_SQL`), so the
 * chip on a row and the chip in the filter cannot disagree.
 *
 * Membership is the union: a bottling is queued when it is neither `verified`
 * nor `rejected` **and** at least one code fires. `NEW` is itself a code, so
 * every bottling a sync creates appears even when nothing else is wrong, while
 * a legacy row appears only when a detector finds something.
 */
export enum ReviewIssueCode {
  /**
   * A sync created the row and nobody has looked at it yet.
   */
  NEW = 'new',
  /**
   * Nothing resolves the bottling to a maker, and the what-if pass says the
   * spelling it carries reaches a producer somebody has already ruled not a
   * whisky producer at all. The verdict exists; it was never recorded on the
   * bottling, which therefore sits in every report with no label.
   */
  PRODUCER_REJECTED = 'producer-rejected',
  /**
   * Neither a producer nor a bottler. The single largest class, and the one
   * an alias fixes for every bottling carrying the spelling at once.
   */
  NO_PRODUCER = 'no-producer',
  /**
   * The canonical name carries no Latin letter — a Cyrillic transliteration
   * such as `Джек Деніелс`, which no alias, no identity and no match key can
   * ever join to its Latin twin. Only a rename fixes it.
   */
  CYRILLIC_NAME = 'cyrillic-name',
  /**
   * Another bottling shares this one's identity: the same folded name, volume
   * and age. One whisky recorded twice.
   */
  DUPLICATE = 'duplicate',
  /**
   * No strength.
   */
  MISSING_ABV = 'missing-abv',
  /**
   * No pack size.
   */
  MISSING_VOLUME = 'missing-volume',
  /**
   * No country, so every country filter hides it.
   */
  MISSING_COUNTRY = 'missing-country',
  /**
   * No whisky type, so every type filter hides it.
   */
  MISSING_TYPE = 'missing-type',
  /**
   * The what-if pass reaches a producer the knowledge base is still
   * withholding. Promoting that producer takes the bottling out of the queue,
   * along with every other one carrying the spelling.
   */
  PRODUCER_WITHHELD = 'producer-withheld',
  /**
   * A type word in the name contradicts the stored type — `Jim Beam Rye`
   * stored as `bourbon`, `Hamiltons Islay Single Malt` stored as `blend`. A
   * cask qualifier (`Bourbon Cask`, `Rye Cask Finish`) is a maturation claim
   * and is excluded.
   */
  TYPE_VS_NAME = 'type-vs-name',
  /**
   * A Scotch region word in the name while the country says somewhere else.
   */
  COUNTRY_VS_NAME = 'country-vs-name',
  /**
   * The strength is outside the range whisky occupies — a liqueur, an RTD, a
   * cask-strength misprint.
   */
  ABV_RANGE = 'abv-range',
  /**
   * The canonical name still carries packaging: a gift box, a tube, glasses.
   */
  NAME_LEFTOVER = 'name-leftover',
  /**
   * A shop's raw name states an age the bottling does not carry. Age is part
   * of a bottling's identity, so filling it merges rather than edits.
   */
  AGE_IN_RAW = 'age-in-raw',
  /**
   * The age came from one shop's spec page and no other shop lists the
   * bottling — the shape of the `VAT 69` four-year-old that is really NAS.
   */
  AGE_SINGLE_STORE = 'age-single-store',
  /**
   * The type or the country is sourced `llm` or `legacy`, which the filters
   * distrust: the value is displayed and never answers a filter.
   */
  UNTRUSTED_FACT = 'untrusted-fact',
  /**
   * A shop contradicts one of the bottling's facts and nobody has
   * acknowledged it.
   */
  CONFLICT = 'conflict',
}

/**
 * How badly a code wants attention. The default sort is by this, then newest
 * first, so the queue is worked worst-first without anybody choosing a filter.
 */
export enum ReviewIssueSeverity {
  /**
   * A verdict already exists elsewhere and has not reached the bottling.
   */
  CRITICAL = 'critical',
  /**
   * The bottling is wrong or unusable as it stands.
   */
  ERROR = 'error',
  /**
   * Something contradicts something else and a person has to choose.
   */
  WARN = 'warn',
  /**
   * Worth looking at once; nothing is provably wrong.
   */
  INFO = 'info',
}

/**
 * Why a producer is in the curation queue.
 *
 * Distinct from {@link ReviewIssueCode} because the two queues answer
 * different questions and share no predicate: a bottling is wrong, a producer
 * is unreachable or unresearched.
 */
export enum ProducerIssueCode {
  /**
   * A new row nobody has judged — what `pnpm research-brands` writes.
   */
  UNVERIFIED = 'unverified',
  /**
   * No alias at all, so nothing can ever resolve to it. The row exists and
   * changes nothing.
   */
  NO_ALIAS = 'no-alias',
  /**
   * Live, but every alias is brand-scoped or under the five-character floor,
   * and at least one unresolved stocked bottling carries the word. The
   * producer is real, the spelling cannot reach it, and one scope change
   * fixes every such bottling at once.
   */
  ALIAS_UNREACHABLE = 'alias-unreachable',
  /**
   * The producer's name appears in the raw names of bottlings that resolve to
   * nothing.
   */
  UNLINKED_MENTIONS = 'unlinked-mentions',
  /**
   * Recorded as a blend while most of its bottlings are single malts — the
   * shape of `mac-talla`, `finlaggan` and `cailleach`, seeded wrong.
   */
  KIND_SUSPECT = 'kind-suspect',
  /**
   * A Scotch distillery with no region, so every region filter hides what it
   * made.
   */
  NO_REGION = 'no-region',
  /**
   * Not a bottler and states no default type, so it contributes nothing to a
   * bottling's type.
   */
  NO_DEFAULT_TYPE = 'no-default-type',
  /**
   * A brand with no parent distillery recorded.
   */
  BRAND_NO_PARENT = 'brand-no-parent',
  /**
   * Not a bottler and its peat band was never researched, so every bottling
   * of it loses its peat tags rather than gaining the right ones.
   */
  PEAT_UNKNOWN = 'peat-unknown',
}

/**
 * Which slice of the curation work a queue read returns.
 */
export enum ReviewQueueStatus {
  /**
   * The work: everything a detector fires on that nobody has decided about.
   */
  OPEN = 'open',
  /**
   * The log of what was confirmed, so a decision stays inspectable.
   */
  VERIFIED = 'verified',
  /**
   * The log of what was ruled out, which is the only way back from a
   * rejection made by mistake.
   */
  REJECTED = 'rejected',
}

/**
 * How a queue page is ordered. A closed vocabulary because the value reaches
 * an `ORDER BY`.
 */
export enum ReviewQueueSort {
  /**
   * Worst first, then newest — the default, and the order the work is worth
   * doing in.
   */
  SEVERITY = 'severity',
  /**
   * Newest first, which answers "what did last night's sync bring in".
   */
  NEWEST = 'newest',
  /**
   * Most shops first, which is how often a wrong fact is being served.
   */
  REACH = 'reach',
}
