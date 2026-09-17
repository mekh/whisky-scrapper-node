import type {
  FactSource,
  FlavorRuleMatchMode,
  FlavorSource,
  KbFlavorEffect,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ProducerSortField,
  ScotlandLegalRegion,
  ScotlandRegion,
  SortOrder,
} from '~enums';

import type { ID } from './entity.interfaces';

/**
 * The producer facts the resolver needs in memory. A projection of
 * `EntityProducer` holding only what a decision reads — the citations, notes
 * and review timestamps stay in the database.
 */
export interface KbProducerFacts {
  /**
   * Producer id, written to `product.producerId` or `bottlerId`.
   */
  id: ID;
  /**
   * Stable slug, used in reports and rule seeds so a diff is readable.
   */
  slug: string;
  /**
   * Display name.
   */
  name: string;
  /**
   * Which kind of entity this is — the resolver branches on `bottler`.
   */
  kind: ProducerKind;
  /**
   * Country FK to write onto resolving bottlings.
   */
  countryId: ID | null;
  /**
   * Region as the market uses it, including `islands`.
   */
  region: ScotlandRegion | null;
  /**
   * The protected SWA region, which never says `islands`.
   */
  legalRegion: ScotlandLegalRegion | null;
  /**
   * The distillery a `brand`-kind row belongs to. Used **only** to arbitrate
   * between a brand match and an in-name match; facts are never inherited
   * through it, because a sibling brand exists precisely because its facts
   * differ.
   */
  parentId: ID | null;
  /**
   * The bottler owning this brand or range, so `Big Peat` reports Douglas
   * Laing without the product name mentioning the company.
   */
  bottlerId: ID | null;
  /**
   * Whisky type name to write onto resolving bottlings, or null to leave the
   * stored value alone.
   */
  defaultTypeName: string | null;
  /**
   * The house peat level — the only source the `peated` tag has.
   */
  peatProfile: PeatProfile;
}

/**
 * One entry of the alias match index.
 */
export interface KbAliasEntry {
  /**
   * The normalized alias (`KbKeyUtils.key`).
   */
  key: string;
  /**
   * Where this alias may be matched.
   */
  scope: ProducerAliasScope;
  /**
   * The producer it names.
   */
  producer: KbProducerFacts;
}

/**
 * A name-pattern rule, flattened for matching.
 */
export interface KbFlavorRule {
  /**
   * The producer this rule is scoped to, or null for a global rule.
   */
  producerId: ID | null;
  /**
   * The normalized pattern.
   */
  pattern: string;
  /**
   * How the pattern is matched.
   */
  matchMode: FlavorRuleMatchMode;
  /**
   * The tag this rule acts on, or null on a peat rule.
   */
  flavorId: ID | null;
  /**
   * Whether the tag is required or forbidden, or null on a peat rule.
   */
  effect: KbFlavorEffect | null;
  /**
   * The peat level this pattern implies, or null on a tag rule.
   */
  peatProfile: PeatProfile | null;
  /**
   * Higher wins among matching peat rules.
   */
  priority: number;
}

/**
 * One curated house-style statement.
 */
export interface KbProducerFlavor {
  /**
   * The producer the statement is about.
   */
  producerId: ID;
  /**
   * The tag.
   */
  flavorId: ID;
  /**
   * What is asserted.
   */
  effect: KbFlavorEffect;
}

/**
 * Everything the resolver matches against, loaded once per run.
 *
 * Loaded per call rather than cached on the service, for the same reason
 * `NormalizeService` takes its brand index as a parameter: the services are
 * singletons and stores sync concurrently, so a cached index would go stale
 * against a knowledge base a review had just changed.
 */
export interface KbIndex {
  /**
   * Alias entries, longest key first, so a specific name wins over a shorter
   * one contained in it.
   */
  aliases: KbAliasEntry[];
  /**
   * Every rule, both global and producer-scoped.
   */
  rules: KbFlavorRule[];
  /**
   * House-style statements, grouped by producer id.
   */
  producerFlavors: Map<ID, KbProducerFlavor[]>;
  /**
   * Flavor ids of `peated` and `smoky`, resolved once. The peat mapping writes
   * these directly instead of resolving names per product.
   */
  peatFlavorIds: KbPeatFlavorIds;
}

/**
 * The two tag ids the peat mapping writes.
 */
export interface KbPeatFlavorIds {
  /**
   * Id of the `peated` tag.
   */
  peated: ID | null;
  /**
   * Id of the `smoky` tag.
   */
  smoky: ID | null;
}

/**
 * A bottling as the resolver reads it: the fields a decision is made from,
 * nothing else.
 */
export interface KbResolveInput {
  /**
   * Canonical product id.
   */
  id: ID;
  /**
   * The cleaned product name. Resolution reads this rather than a store's raw
   * name: the catalogue's canonical names are almost entirely Latin, while
   * nearly every `nameOrig` is Ukrainian prose.
   */
  name: string | null;
  /**
   * The brand value, when the bottling has one.
   */
  brand: string | null;
}

/**
 * What the resolver decided about one bottling.
 */
export interface KbResolution {
  /**
   * Canonical product id.
   */
  productId: ID;
  /**
   * The resolved distillery or blender, or null when nothing matched — which
   * is a deliberate "unknown", not a fallback.
   */
  producer: KbProducerFacts | null;
  /**
   * The resolved independent bottler, or null.
   */
  bottler: KbProducerFacts | null;
  /**
   * The peat level that applies to this bottling, after rules and the
   * producer's profile.
   */
  peatProfile: PeatProfile;
  /**
   * Why the peat level was chosen, for the dry-run diff and the review
   * screen.
   */
  peatReason: KbPeatReason;
  /**
   * The rule pattern that decided the peat level, when a rule did.
   */
  peatRulePattern: string | null;
  /**
   * Tags this bottling must carry, from rules and house-style `require` rows.
   */
  requiredFlavorIds: ID[];
  /**
   * Tags this bottling must not carry, from rules and house-style `forbid`
   * rows.
   */
  forbiddenFlavorIds: ID[];
  /**
   * House-style tags eligible to fill a bottling the model answered "unknown"
   * for.
   */
  baselineFlavorIds: ID[];
}

/**
 * How a bottling's peat level was decided.
 */
export enum KbPeatReason {
  /**
   * A producer-scoped name rule matched.
   */
  RULE_PRODUCER = 'rule-producer',
  /**
   * A global name rule matched.
   */
  RULE_GLOBAL = 'rule-global',
  /**
   * Taken from the resolved producer's house profile.
   */
  PRODUCER = 'producer',
  /**
   * A bottler resolved but the distillery did not — an independent bottling of
   * an undisclosed source.
   */
  BOTTLER_ONLY = 'bottler-only',
  /**
   * Nothing resolved.
   */
  UNRESOLVED = 'unresolved',
}

/**
 * The producer assignment to write for one bottling.
 */
export interface KbProducerWrite {
  /**
   * Canonical product id.
   */
  productId: ID;
  /**
   * Resolved producer id, or null to clear.
   */
  producerId: ID | null;
  /**
   * Resolved bottler id, or null to clear.
   */
  bottlerId: ID | null;
  /**
   * How the assignment was decided.
   */
  source: FactSource;
}

/**
 * The knowledge-base-owned fact values to write for one bottling. A null value
 * means "the knowledge base states nothing here", and the stored value is left
 * alone — it is not a request to clear the column.
 */
export interface KbFactWrite {
  /**
   * Canonical product id.
   */
  productId: ID;
  /**
   * Country id the resolved producer states.
   */
  countryId: ID | null;
  /**
   * Type id the resolved producer's default type states.
   */
  typeId: ID | null;
}

/**
 * The flavor links to add and remove for one bottling.
 */
export interface KbFlavorWrite {
  /**
   * Canonical product id.
   */
  productId: ID;
  /**
   * Tags to link, written with `FlavorSource.KB`.
   */
  insertFlavorIds: ID[];
  /**
   * Tags to unlink. Any source but `manual` is removed, which is what lets the
   * pass clear a wrong `llm` or `scrape` peat tag.
   */
  deleteFlavorIds: ID[];
}

/**
 * One flavor link as the reconciliation pass reads it.
 */
export interface KbReconcileFlavor {
  /**
   * The linked tag.
   */
  flavorId: ID;

  /**
   * The tag's name, so a report can be read without a second lookup.
   */
  name: string;

  /**
   * Who wrote the link.
   */
  source: FlavorSource;
}

/**
 * One bottling as the reconciliation pass reads it: everything the knowledge
 * base might change, plus the provenance that decides whether it may.
 *
 * It is read in a single query over the whole catalogue rather than per store
 * or per page. The unit of the pass is a group of identically-named bottlings,
 * and a group cannot be assembled from a slice of the catalogue.
 */
export interface KbReconcileRow {
  /**
   * Canonical product id.
   */
  id: ID;

  /**
   * The bottling's canonical name, which may be null when cleaning left
   * nothing.
   */
  name: string | null;

  /**
   * The brand value the catalogue carries, if any.
   */
  brand: string | null;

  /**
   * The stored country, for the diff.
   */
  countryId: ID | null;

  /**
   * Where the stored country came from.
   */
  countrySource: FactSource | null;

  /**
   * The stored whisky type, for the diff.
   */
  typeId: ID | null;

  /**
   * Where the stored type came from.
   */
  typeSource: FactSource | null;

  /**
   * The producer currently recorded, so the pass can report a change rather
   * than rewriting every row every run.
   */
  producerId: ID | null;

  /**
   * The bottler currently recorded.
   */
  bottlerId: ID | null;

  /**
   * Set when a person curated the tags by hand, in which case the knowledge
   * base leaves every link alone.
   */
  flavorsCuratedAt: Date | null;

  /**
   * Every flavor link the bottling carries today.
   */
  flavors: KbReconcileFlavor[];
}

/**
 * A set of bottlings sharing one lower-cased name, resolved as a unit.
 */
export interface KbNameGroup {
  /**
   * The lower-cased name, or a per-bottling key when the name is null.
   */
  key: string;

  /**
   * The name as stored, passed to the resolver.
   */
  name: string | null;

  /**
   * The bottlings in the group.
   */
  rows: KbReconcileRow[];
}

/**
 * How an apply pass should treat the bottlings that resolve to nothing.
 */
export interface KbApplyOptions {
  /**
   * Leave the peat links of an unresolved bottling alone.
   *
   * Off by default, and that default is the product decision: an unresolved
   * bottling states nothing about peat, so keeping a model's guess is exactly
   * how a whisky goes missing from a filtered result. The flag exists to stage
   * a rollout — apply the facts first, remove the guesses once the knowledge
   * base covers enough of the catalogue.
   */
  keepUnknownPeat?: boolean;
}

/**
 * Everything an apply pass decided, before any of it is written.
 */
export interface KbApplyPlan {
  /**
   * The name groups, in the order they were resolved.
   */
  groups: KbNameGroup[];

  /**
   * One resolution per group, index-aligned with {@link groups}.
   */
  resolutions: KbResolution[];

  /**
   * Producer and bottler assignments, one per bottling.
   */
  producers: KbProducerWrite[];

  /**
   * Country and type writes, one per bottling.
   */
  facts: KbFactWrite[];

  /**
   * Flavor link changes, one per bottling; most are empty.
   */
  flavors: KbFlavorWrite[];
}

/**
 * What one reconciliation pass over the catalogue did.
 *
 * The pass is what turns a stored decision into catalogue facts: promoting a
 * producer records a claim, and nothing reads that claim until the catalogue is
 * re-resolved against it. Both callers report the same numbers — the CLI to a
 * terminal, the review screen to the person who just promoted a row.
 */
export interface KbReconcileSummary {
  /**
   * Name groups considered.
   */
  groups: number;

  /**
   * Of those, how many resolved to a producer.
   */
  resolved: number;

  /**
   * Bottlings whose producer or bottler link was written.
   */
  producerWrites: number;

  /**
   * Bottlings whose country or type was written — a value **or** its source,
   * which is what takes a bottling out of the review queue when the value was
   * already right but nothing trustworthy had said so.
   */
  factWrites: number;

  /**
   * Bottlings whose flavour links changed.
   */
  flavorWrites: number;
}

/**
 * One producer as the review screen reads it.
 *
 * Flattened rather than nested: the screen is a table, and `parentSlug` /
 * `bottlerSlug` are what a reviewer recognises, not two more ids.
 */
export interface ProducerReviewRow {
  /**
   * Producer id, the handle a `PATCH` uses.
   */
  id: ID;

  /**
   * Stable kebab-case key.
   */
  slug: string;

  /**
   * Display name.
   */
  name: string;

  /**
   * `ProducerKind` value.
   */
  kind: ProducerKind;

  /**
   * Common region, `islands` included.
   */
  region: ScotlandRegion | null;

  /**
   * The protected SWA region.
   */
  legalRegion: ScotlandLegalRegion | null;

  /**
   * Owning company.
   */
  owner: string | null;

  /**
   * Type every bottling of this producer is, when its range is single-typed.
   */
  defaultTypeName: string | null;

  /**
   * The peat band. This is the field a reviewer is really here for.
   */
  peatProfile: PeatProfile;

  /**
   * Review status; `unverified` rows are stored and ignored by the resolver.
   */
  status: KbStatus;

  /**
   * The researcher's self-assessed confidence.
   */
  confidence: string | null;

  /**
   * Space-separated citations.
   */
  sourceUrls: string | null;

  /**
   * What the researcher was unsure of, and anything deliberately withheld.
   */
  note: string | null;

  /**
   * When a person last confirmed the row.
   */
  verifiedAt: Date | null;

  /**
   * ISO country code.
   */
  countryCode: string | null;

  /**
   * The country's Ukrainian display name, for the flag tooltip.
   */
  countryName: string | null;

  /**
   * The country's flag emoji.
   */
  countryIcon: string | null;

  /**
   * The parent distillery's slug, for a sibling brand.
   */
  parentSlug: string | null;

  /**
   * The parent's id, the handle the link editor writes back.
   */
  parentId: ID | null;

  /**
   * The parent's display name, so a link reads without a second request.
   */
  parentName: string | null;

  /**
   * The owning bottler's slug, for a bottler's own range.
   */
  bottlerSlug: string | null;

  /**
   * The bottler's id, the handle the link editor writes back.
   */
  bottlerId: ID | null;

  /**
   * The bottler's display name.
   */
  bottlerName: string | null;

  /**
   * When the row was created — the listing's «Додано» column.
   */
  createdAt: Date;

  /**
   * How many bottlings resolve to this producer **today**. Structurally zero
   * for a withheld one: the resolver's index only loads `verified` and `auto`
   * rows, so nothing can resolve to one until it is promoted.
   */
  productCount: number;

  /**
   * How many bottlings would resolve to it if the whole withheld queue went
   * live — the only number that can rank the withheld tab, since
   * `productCount` is zero across all of it.
   *
   * Null on the tabs where it is not computed (`verified`, `auto`,
   * `rejected`), where `productCount` is a real answer. Zero means the
   * opposite of null: nothing would reach this row at all.
   */
  potentialReach: number | null;
}

/**
 * One display name behind a producer row on the review screen — what expanding
 * the row lists. For a live producer these are the bottlings that resolve to
 * it today; for a withheld one, the bottlings that **would** resolve if it
 * were promoted.
 *
 * Grouped by name rather than one row per bottling: the same whisky in three
 * volumes is three bottlings, and the catalogue link is built from the name,
 * so ungrouped rows were three identical links in a row.
 */
export interface ProducerProductRow {
  /**
   * The display name — canonical where one exists, otherwise the longest raw
   * store name, which is also what the catalogue's search matches.
   */
  name: string | null;

  /**
   * How many distinct bottlings share the name (volumes, ages, gift boxes).
   */
  productCount: number;

  /**
   * Whether any store currently lists any of them in stock.
   */
  inStock: boolean;
}

/**
 * A brand key nothing in the knowledge base resolves.
 */
export interface UnresolvedBrandRow {
  /**
   * The brand name as the catalogue spells it, typos included.
   */
  brand: string;

  /**
   * How many bottlings carry it.
   */
  productCount: number;
}

/**
 * What the review screen's tabs badge themselves with.
 */
export interface ProductReviewSummary {
  /**
   * Producers by review status.
   */
  producers: {
    /**
     * Confirmed by a person.
     */
    verified: number;

    /**
     * Live on the auto-gate's own judgement.
     */
    auto: number;

    /**
     * Stored and ignored until somebody looks.
     */
    unverified: number;

    /**
     * Ruled out by a person as not a whisky producer at all. Never resolves,
     * never returns to the queue unless somebody puts it back.
     */
    rejected: number;
  };

  /**
   * Bottlings whose whisky type the filters no longer trust.
   */
  untrustedTypes: number;

  /**
   * Bottlings whose country the filters no longer trust.
   */
  untrustedCountries: number;

  /**
   * Bottlings with **either** fact untrusted — the size of the actual queue.
   *
   * Deliberately not derivable on the client: `untrustedTypes +
   * untrustedCountries` double-counts every bottling whose type and country
   * are both untrusted, which is 892 of them, and a badge that says 2400 over
   * a list of 1508 rows is a badge nobody can trust.
   */
  untrustedFacts: number;

  /**
   * Of those, how many resolve to no producer at all.
   *
   * The queue's two halves need different work, and this number is what lets
   * the screen say so: the unresolved half is a **symptom** of the
   * unresolved-producer problem and is cured a producer at a time, while the
   * remainder is the part only a person can settle.
   */
  untrustedFactsUnresolved: number;

  /**
   * Unresolved cross-shop contradictions.
   */
  openConflicts: number;

  /**
   * Whether any brand key resolves to no producer at all — 1 when the queue is
   * non-empty, since the full list is a separate read.
   */
  unresolvedBrands: number;

  /**
   * Bottlings by their place in the new-product queue.
   */
  products: ProductReviewStatusCounts;
}

/**
 * What a reviewer's verdict wrote, plus the queue counters as they now stand.
 *
 * The counters ride along because they are exactly what changes on the
 * screen's tab badge and its segment chips; without them a client re-reads the
 * summary after every decision.
 */
export interface ProductReviewStatusResult {
  /**
   * How many rows the verdict actually wrote — lower than the request's id
   * count when some were already in that state.
   */
  updated: number;

  /**
   * The queue counters after the write.
   */
  products: ProductReviewStatusCounts;
}

/**
 * How the catalogue is distributed across the new-product queue.
 *
 * The four numbers sum to the whole `product` table, which is what makes
 * `legacy` worth serving rather than deriving: it is the share of the
 * catalogue nobody has ever looked at, and it is the number the retro-enqueue
 * decision is made on.
 */
export interface ProductReviewStatusCounts {
  /**
   * Waiting for a person.
   */
  pending: number;

  /**
   * Looked at and kept.
   */
  verified: number;

  /**
   * Ruled out as not whisky. Hidden from the catalogue, still scraped,
   * reversible.
   */
  rejected: number;

  /**
   * Predates the queue and was deliberately not enrolled in it. Not work —
   * a separate decision with its own window.
   */
  legacy: number;
}

/**
 * One bottling whose type or country the filters distrust.
 */
export interface ProductFactReviewRow {
  /**
   * Canonical product id — what `POST /product/update` takes.
   */
  id: ID;

  /**
   * The bottling's canonical name.
   */
  name: string | null;

  /**
   * A raw listing name, so an unnamed bottling is still recognisable.
   */
  nameOrig: string | null;

  /**
   * The brand as the catalogue spells it.
   */
  brand: string | null;

  /**
   * The shop's own brand spelling, kept on the bottling. It is the key an
   * alias is minted from when a reviewer links this row to a producer.
   */
  brandOrig: string | null;

  /**
   * The stored whisky type.
   */
  type: string | null;

  /**
   * Where that type came from.
   */
  typeSource: string | null;

  /**
   * The stored country code.
   */
  countryCode: string | null;

  /**
   * The country's Ukrainian name, for the flag's tooltip.
   */
  countryName: string | null;

  /**
   * The country's flag emoji. Null for a country that has none, in which case
   * the label is shown on its own — never a tooltip with no trigger.
   */
  countryIcon: string | null;

  /**
   * Where that country came from.
   */
  countrySource: string | null;

  /**
   * The resolved producer's slug, or null when nothing resolved.
   *
   * This is the column that says **what to do about the row**, and it splits
   * the queue almost cleanly in two. A bottling with no producer has no
   * authority behind either fact, and the cure is to resolve the producer —
   * one promotion fixes every bottling that producer makes, where editing the
   * bottling fixes one. A bottling *with* a producer is here because the
   * knowledge base has already said all it can (a producer whose range spans
   * several types states no `defaultTypeName`), so a person deciding is the
   * last resort rather than the first.
   *
   * Measured when this was added: 1395 of the 1508 rows had no producer.
   */
  producerSlug: string | null;

  /**
   * How many shops carry the bottling — the reason to prioritise it.
   */
  storeCount: number;

  /**
   * A few of the shops' own pages for this bottling, in-stock first. Capped:
   * a bottling can be listed by nineteen shops and the row still has to be
   * readable.
   */
  stores: ReviewStoreLink[];
}

/**
 * One shop's own page for a bottling under review.
 */
export interface ReviewStoreLink {
  /**
   * The shop's slug, for its monogram.
   */
  slug: string;

  /**
   * The shop's display name.
   */
  name: string;

  /**
   * The listing's URL, as the shop published it.
   */
  url: string;

  /**
   * Whether the shop still lists it. An out-of-stock page is still worth
   * reading, so it is offered rather than hidden — just marked.
   */
  inStock: boolean;
}

/**
 * One bottling in the new-product queue.
 *
 * The field set is chosen so a parse error is visible without opening
 * anything: `name` beside `nameOrig` is the comparison the whole screen is
 * for, and the specs beside them are what the cleaner lifted out of that raw
 * name.
 */
export interface ProductReviewQueueRow {
  /**
   * Canonical product id — what the review mutation and `POST /product/update`
   * both take.
   */
  id: ID;

  /**
   * The bottling's canonical name, as the cleaner left it.
   */
  name: string | null;

  /**
   * The longest raw listing name behind it. Read together with `name`, this
   * pair *is* the review: everything the cleaner dropped is the difference
   * between them, and everything it dropped wrongly is the defect.
   */
  nameOrig: string | null;

  /**
   * The frozen match key.
   *
   * On screen nowhere else, and it belongs here because the key is derived
   * once and never re-derived: a listing keyed wrongly is a duplicate that
   * costs a manual merge later, and this is the only moment it is cheap to
   * notice. Null means the row can never be matched automatically.
   */
  matchKey: string | null;

  /**
   * Age statement in years.
   *
   * Age and volume are **components of the frozen key**, so a wrong one is
   * not a cosmetic error — it decides which listings land on this row. A
   * Cyrillic `уо` the reader once did not know collapsed four Dalmore ages
   * onto one bottling.
   */
  age: number | null;

  /**
   * Where the age came from.
   */
  ageSource: string | null;

  /**
   * Strength.
   */
  abv: number | null;

  /**
   * Where the strength came from.
   */
  abvSource: string | null;

  /**
   * Pack size in millilitres — the sum of a gift set's bottles.
   */
  volumeMl: number | null;

  /**
   * Where the volume came from.
   */
  volumeSource: string | null;

  /**
   * The stored whisky type.
   */
  type: string | null;

  /**
   * Where that type came from.
   */
  typeSource: string | null;

  /**
   * The stored country code.
   */
  countryCode: string | null;

  /**
   * The country's Ukrainian name, for the flag's tooltip.
   */
  countryName: string | null;

  /**
   * The country's flag emoji, or null for a country that has none.
   */
  countryIcon: string | null;

  /**
   * Where that country came from.
   */
  countrySource: string | null;

  /**
   * The label a report would print — the resolved producer's name, falling
   * back to the bottler's.
   */
  brand: string | null;

  /**
   * The resolved producer's slug, or null when nothing resolved.
   */
  producerSlug: string | null;

  /**
   * The spelling a shop used.
   *
   * Worth a column here rather than anywhere else: a null `producerSlug`
   * beside a non-null `brandOrig` is the signal "the knowledge base does not
   * know this maker yet", and on a brand-new bottling that is the commonest
   * real defect.
   */
  brandOrig: string | null;

  /**
   * The bottling's flavour tags. The LLM pass answers for new products, so a
   * wrong tag is a parse error like any other.
   */
  flavors: string[];

  /**
   * How many shops carry it in stock.
   */
  storeCount: number;

  /**
   * A few of the shops' own pages, in-stock first — the fastest way to check
   * what the listing actually said.
   */
  stores: ReviewStoreLink[];

  /**
   * Where the row sits in the queue. Echoed so one row renderer serves all
   * three buckets.
   */
  reviewStatus: string | null;

  /**
   * When a person last decided about it. Null while it is still `pending`.
   */
  reviewedAt: Date | null;

  /**
   * When a sync first created the row.
   */
  createdAt: Date;
}

/**
 * A reviewer's edit, and what applying it did to the catalogue.
 *
 * The two travel together because they are one action. A promotion that is
 * stored but not applied changes nothing a filter reads, and a screen that
 * reports the first without the second is telling half the truth — which is
 * exactly how two promotions left the review counts untouched.
 */
export interface ProducerPatchResult {
  /**
   * The producer as it now stands.
   */
  producer: ProducerReviewRow;

  /**
   * What re-resolving the catalogue against the edit wrote.
   */
  applied: KbReconcileSummary;
}

/**
 * One producer row parented to another — a separately-named line whose facts
 * deliberately differ from its parent's.
 */
export interface ProducerChildRow {
  /**
   * The child's own id.
   */
  id: ID;

  /**
   * Its slug.
   */
  slug: string;

  /**
   * Its display name.
   */
  name: string;

  /**
   * What kind of producer it is.
   */
  kind: ProducerKind;

  /**
   * Its own peat band. Never inherited from the parent — a sibling line
   * exists precisely because this differs.
   */
  peatProfile: PeatProfile;

  /**
   * Its review status.
   */
  status: KbStatus;

  /**
   * How many bottlings resolve to it.
   */
  productCount: number;
}

/**
 * One name-pattern rule, resolved to readable labels.
 */
export interface ProducerRuleRow {
  /**
   * The rule's id — the handle a delete uses. Global rules carry one too, but
   * no endpoint accepts it: they are migration-authored context.
   */
  id: ID;

  /**
   * The normalized pattern matched against a bottling's name.
   */
  pattern: string;

  /**
   * `word` or `prefix` — the latter exists for Ukrainian inflection.
   */
  matchMode: FlavorRuleMatchMode;

  /**
   * The flavour tag the rule asserts, when it is a tag rule.
   */
  flavorName: string | null;

  /**
   * What it asserts about that tag.
   */
  effect: KbFlavorEffect | null;

  /**
   * The peat band the rule asserts, when it is a peat rule. A rule is one or
   * the other, never both.
   */
  peatProfile: PeatProfile | null;

  /**
   * Higher wins. Negations sit at 100 so they beat every positive claim.
   */
  priority: number;

  /**
   * Citations backing the rule.
   */
  sourceUrls: string | null;

  /**
   * Why the rule exists.
   */
  note: string | null;
}

/**
 * A reviewer's new name-pattern rule for one producer, already validated and
 * normalized by the domain layer: the pattern is a `KbKeyUtils.key`, and
 * exactly one of the peat band or the tag claim is set.
 */
export interface ProducerRuleInput {
  /**
   * The producer the rule is scoped to. Global rules are migration-authored
   * and cannot be created here.
   */
  producerId: ID;

  /**
   * The normalized pattern.
   */
  pattern: string;

  /**
   * `word` or `prefix`.
   */
  matchMode: FlavorRuleMatchMode;

  /**
   * The peat band, for a peat rule.
   */
  peatProfile: PeatProfile | null;

  /**
   * The flavour tag id, for a tag rule.
   */
  flavorId: ID | null;

  /**
   * What the rule asserts about the tag.
   */
  effect: KbFlavorEffect | null;

  /**
   * Higher wins; negations conventionally sit at 100.
   */
  priority: number;

  /**
   * Why the rule exists — the reviewer's own words.
   */
  note: string | null;
}

/**
 * Everything a reviewer needs to judge one producer.
 *
 * The three extra lists are not decoration: `producer.peatProfile` means the
 * **core range**, and the exceptions live elsewhere — a separately-named line
 * is its own `children` row, a line that is only a word in a bottling's name is
 * a `rules` row, and the global peat rules apply to every producer. A reviewer
 * shown only the single peat value is being asked to judge it with the
 * overrides hidden, which is what makes «what do I pick for Bruichladdich?» an
 * unanswerable question rather than an easy one.
 */
export interface ProducerDetail {
  /**
   * The producer itself, as the review listing states it.
   */
  producer: ProducerReviewRow;

  /**
   * Named lines parented to this producer, with their own peat bands.
   */
  children: ProducerChildRow[];

  /**
   * Rules scoped to this producer.
   */
  rules: ProducerRuleRow[];

  /**
   * The global peat rules, which apply to every producer. Read-only context.
   */
  globalPeatRules: ProducerRuleRow[];

  /**
   * Every spelling that resolves to this producer, longest key first.
   */
  aliases: ProducerAliasRow[];
}

/**
 * One spelling that resolves to a producer, as the producer card lists it.
 */
export interface ProducerAliasRow {
  /**
   * The alias id — the handle a delete uses.
   */
  id: ID;

  /**
   * The normalized key the resolver matches on.
   */
  key: string;

  /**
   * Where the alias may be matched: a brand value, a product name, or both.
   */
  scope: ProducerAliasScope;

  /**
   * Why the alias exists, when somebody wrote it down.
   */
  note: string | null;

  /**
   * When the alias was added.
   */
  createdAt: Date;
}

/**
 * One owning company, as the owner field's autocomplete offers it.
 *
 * An object rather than a bare string so the response can gain a hint — how
 * many producers that company owns, say — without a breaking change, which is
 * the reason `TypeBrand` has the same shape.
 */
export interface ProducerOwnerRow {
  /**
   * The company exactly as `producer.owner` stores it. The field stays free
   * text, so this is a suggestion, never a closed vocabulary.
   */
  name: string;
}

/**
 * One producer as a picker offers it — the parent, bottler and link pickers.
 */
export interface ProducerOptionRow {
  /**
   * The producer's id, which the picker writes back.
   */
  id: ID;

  /**
   * Its stable kebab-case key, shown beside the name so two makers spelled
   * alike are told apart.
   */
  slug: string;

  /**
   * Its display name.
   */
  name: string;

  /**
   * What kind of producer it is.
   */
  kind: ProducerKind;

  /**
   * Its review status, so a picker can mark a withheld row.
   */
  status: KbStatus;

  /**
   * The country's flag emoji, or null.
   */
  countryIcon: string | null;
}

/**
 * The counts behind the review screen's facts badge.
 */
export interface UntrustedFactCounts {
  /**
   * Bottlings whose type is untrusted.
   */
  type: number;

  /**
   * Bottlings whose country is untrusted.
   */
  country: number;

  /**
   * Bottlings with either — the distinct total, always at most the sum.
   */
  either: number;

  /**
   * Of `either`, how many resolve to no producer.
   */
  eitherUnresolved: number;
}

/**
 * One unresolved cross-shop contradiction, resolved to readable labels.
 */
export interface ReviewConflictRow {
  /**
   * The bottling whose stored fact is contradicted.
   */
  productId: ID;

  /**
   * The bottling's name.
   */
  productName: string | null;

  /**
   * The shop making the claim.
   */
  storeId: ID;

  /**
   * That shop's slug.
   */
  storeSlug: string;

  /**
   * Which fact is disputed.
   */
  attribute: string;

  /**
   * The catalogue's value, as a name or code rather than an id.
   */
  storedValue: string | null;

  /**
   * The shop's value, likewise.
   */
  claimedValue: string | null;

  /**
   * Where the catalogue's value came from.
   */
  storedSource: string | null;

  /**
   * How many syncs have seen the claim.
   */
  seenCount: number;

  /**
   * When it was last seen.
   */
  lastSeenAt: Date;
}

/**
 * The fields the auto-gate reads. Deliberately narrow: the gate is a policy
 * about evidence, so it sees the claim, its citations and the two things that
 * can corroborate a peat level, and nothing else.
 */
export interface KbGateInput {
  /**
   * Stable kebab-case key. Read for a peat word in the producer's own name.
   */
  slug: string;

  /**
   * `ProducerKind` value; a bottler passes unconditionally.
   */
  kind: string;

  /**
   * ISO country code. A producer with no country is never credible.
   */
  countryCode: string;

  /**
   * Common region; `islay` corroborates a positive peat claim.
   */
  region: string;

  /**
   * `PeatProfile` value.
   */
  peatProfile: string;

  /**
   * The researcher's self-assessed confidence.
   */
  confidence: string;

  /**
   * Space-separated citations.
   */
  sourceUrls: string;
}

/**
 * A brand nothing has ever been researched for, with the evidence available.
 */
export interface UnresearchedBrandRow {
  /**
   * The brand name exactly as the catalogue spells it.
   */
  brand: string;

  /**
   * How many bottlings carry it.
   */
  productCount: number;

  /**
   * A few of its product names, which are often the decisive evidence.
   */
  sampleNames: string[] | null;
}

/**
 * A producer about to be stored from research rather than from the seed.
 */
export interface ResearchedProducer {
  /**
   * Stable kebab-case key.
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
   * ISO country code, or empty.
   */
  countryCode: string;

  /**
   * Common region, or empty.
   */
  region: string;

  /**
   * Protected SWA region, or empty.
   */
  legalRegion: string;

  /**
   * Owning company, or empty.
   */
  owner: string;

  /**
   * Single-type range's type name, or empty.
   */
  defaultTypeName: string;

  /**
   * `PeatProfile` value.
   */
  peatProfile: string;

  /**
   * What the auto-gate decided.
   */
  status: string;

  /**
   * Self-assessed confidence.
   */
  confidence: string;

  /**
   * Space-separated citations.
   */
  sourceUrls: string;

  /**
   * The proposal's own caveats, plus anything the gate withheld — this is what
   * makes a withheld answer worth storing rather than discarding.
   */
  note: string;
}

/**
 * Which producers a listing page returns, in which order.
 */
export interface ProducerListQuery {
  /**
   * Restrict to one kind — the distilleries, the brands, the blends or the
   * bottlers. Omit for all four.
   */
  kind?: ProducerKind;

  /**
   * Restrict to one review status. Omit for all.
   */
  status?: KbStatus;

  /**
   * Case-insensitive substring of the name or the slug.
   */
  name?: string;

  /**
   * The column to order by. Absent is the third sort state — the listing's
   * own default order, which no column header can express.
   */
  sort?: ProducerSortField;

  /**
   * Which way to order. Ignored without `sort`.
   */
  order?: SortOrder;

  /**
   * 1-based page number.
   */
  page?: number;

  /**
   * Page size.
   */
  perPage?: number;
}

/**
 * A new producer, as the create form states it.
 */
export interface ProducerCreateInput {
  /**
   * Display name. The slug is derived from it when none is given.
   */
  name: string;

  /**
   * The kind of producer.
   */
  kind: ProducerKind;

  /**
   * Stable kebab-case key. Derived from the name when absent; a collision is
   * a 409, never a silently suffixed second row.
   */
  slug?: string;

  /**
   * ISO country code, resolved against the `country` table.
   */
  countryCode?: string;

  /**
   * Common region, `islands` included.
   */
  region?: ScotlandRegion;

  /**
   * The protected SWA region; never `islands`.
   */
  legalRegion?: ScotlandLegalRegion;

  /**
   * Owning company.
   */
  owner?: string;

  /**
   * The distillery or brand this row belongs to.
   */
  parentId?: ID;

  /**
   * The independent bottler whose range this row is.
   */
  bottlerId?: ID;

  /**
   * The type every bottling of this producer is.
   */
  defaultTypeName?: string;

  /**
   * The peat band. Defaults to `unknown`, which removes tags rather than
   * asserting any.
   */
  peatProfile?: PeatProfile;

  /**
   * Review status. Defaults to `verified` — a person typed this row, which is
   * exactly what the status means.
   */
  status?: KbStatus;

  /**
   * Space-separated citations.
   */
  sourceUrls?: string;

  /**
   * Free text: what was decided and why.
   */
  note?: string;

  /**
   * Spellings that must resolve to the new row. The name itself is always
   * added, so this is for the shop spellings that differ from it.
   */
  aliases?: string[];
}
