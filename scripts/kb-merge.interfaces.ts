/**
 * One researched producer, as an agent wrote it and as the seed file stores
 * it. Every field is a string because a TSV has no types; the migration's
 * joins and the database's own constraints are what turn them into facts.
 */
export interface KbProducerRow {
  /**
   * Stable kebab-case identifier, referenced by every other file.
   */
  slug: string;

  /**
   * Display name.
   */
  name: string;

  /**
   * `ProducerKind` value.
   */
  kind: string;

  /**
   * ISO country code from the `country` table.
   */
  countryCode: string;

  /**
   * `ScotlandRegion` value — the market convention, `islands` included.
   */
  region: string;

  /**
   * `ScotlandLegalRegion` value — the protected SWA region, never `islands`.
   */
  legalRegion: string;

  /**
   * Owning company.
   */
  owner: string;

  /**
   * Whisky type name every bottling of this producer carries, or empty when
   * the range spans several.
   */
  defaultTypeName: string;

  /**
   * `PeatProfile` value.
   */
  peatProfile: string;

  /**
   * Slug of the distillery a brand row belongs to.
   */
  parentSlug: string;

  /**
   * Slug of the bottler that owns this brand or range.
   */
  bottlerSlug: string;

  /**
   * `KbStatus` value; the seed always writes `unverified`.
   */
  status: string;

  /**
   * The researcher's self-assessed confidence.
   */
  confidence: string;

  /**
   * Space-separated citation URLs.
   */
  sourceUrls: string;

  /**
   * Reviewer notes and withheld claims.
   */
  note: string;
}

/**
 * One spelling that resolves to a producer.
 */
export interface KbAliasRow {
  /**
   * The spelling. Raw as an agent wrote it, normalized once merged.
   */
  key: string;

  /**
   * The producer it names.
   */
  producerSlug: string;

  /**
   * `ProducerAliasScope` value.
   */
  scope: string;

  /**
   * Why this spelling exists, when it is not obvious.
   */
  note: string;
}

/**
 * One curated house-style statement.
 */
export interface KbFlavorRow {
  /**
   * The producer the statement is about.
   */
  producerSlug: string;

  /**
   * The flavor tag name.
   */
  flavor: string;

  /**
   * `KbFlavorEffect` value.
   */
  effect: string;

  /**
   * The researcher's confidence.
   */
  confidence: string;

  /**
   * Space-separated citation URLs.
   */
  sourceUrls: string;

  /**
   * Notes.
   */
  note: string;
}

/**
 * One name-pattern rule, global when `producerSlug` is empty.
 */
export interface KbRuleRow {
  /**
   * The producer this rule is scoped to, or empty for a global rule.
   */
  producerSlug: string;

  /**
   * The pattern to look for. Raw as authored, normalized once merged.
   */
  pattern: string;

  /**
   * `FlavorRuleMatchMode` value.
   */
  matchMode: string;

  /**
   * The tag this rule acts on, or empty on a peat rule.
   */
  flavor: string;

  /**
   * `KbFlavorEffect` value, or empty on a peat rule.
   */
  effect: string;

  /**
   * `PeatProfile` value, or empty on a tag rule.
   */
  peatProfile: string;

  /**
   * Higher wins among matching peat rules.
   */
  priority: number;

  /**
   * Space-separated citation URLs.
   */
  sourceUrls: string;

  /**
   * Notes.
   */
  note: string;
}

/**
 * What the merge could not accept or could not reconcile.
 *
 * This is the deliverable a reviewer actually reads. Sixteen researchers
 * working independently will disagree, and the disagreements — especially
 * about peat — are exactly the rows where the seed is most likely to be wrong.
 */
export interface KbMergeReport {
  /**
   * Producers two agents gave different peat levels. Every one needs a human.
   */
  peatConflicts: string[];

  /**
   * Rows dropped for failing validation, with the reason.
   */
  rejected: string[];

  /**
   * Spellings two agents pointed at different producers. Both are dropped: a
   * spelling that resolves two ways would otherwise resolve unpredictably.
   */
  aliasConflicts: string[];

  /**
   * References to producers nobody described, cleared rather than imported.
   */
  danglingRefs: string[];

  /**
   * Aliases moved to brand scope because they were too short to match safely
   * inside a product name, and peat claims reduced to `unknown` for want of a
   * citation.
   */
  downgraded: string[];

  /**
   * Curation the reviewer applied on top of the research: producers folded
   * together and fields overridden, each with the reason it was needed.
   */
  curated: string[];
}

/**
 * One reviewer decision folding a duplicate producer into the row that keeps
 * it.
 *
 * Sixteen agents researching overlapping brand lists coin two slugs for one
 * producer often enough that this needs a first-class record rather than an
 * edit to somebody's research: `Woodford Reserve` arrived as both `woodford`
 * and `woodford-reserve`, and leaving both meant one of them held the aliases
 * while the other held the citations.
 */
export interface KbSlugMerge {
  /**
   * The slug being retired. Every reference to it is rewritten.
   */
  fromSlug: string;

  /**
   * The slug that survives.
   */
  toSlug: string;

  /**
   * Why the two are the same producer.
   */
  note: string;
}

/**
 * One reviewer decision overriding a single field of a merged producer.
 *
 * This is where a cross-check lands. The research stays exactly as the agents
 * wrote it — which is what makes a disagreement auditable — and the correction
 * sits beside it, naming its own reason.
 */
export interface KbOverride {
  /**
   * The producer to correct.
   */
  slug: string;

  /**
   * Which field of {@link KbProducerRow} to set.
   */
  field: string;

  /**
   * The value to set it to. An empty value clears the field.
   */
  value: string;

  /**
   * Why the researched value was wrong, and what says so.
   */
  note: string;
}
