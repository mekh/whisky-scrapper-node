import type {
  KbStatus,
  ProducerIssueCode,
  ProducerKind,
  ProductReviewStatus,
  ReviewIssueCode,
  ReviewIssueSeverity,
  ReviewQueueSort,
  ReviewQueueStatus,
} from '~enums';

import type { ID } from './entity.interfaces';
import type { KbProducerFacts } from './kb.interfaces';

/**
 * What the curation screen's what-if pass concluded about the bottlings that
 * resolve to nothing today.
 *
 * Two maps rather than two id lists because the chip has to name the producer
 * it reached — "resolves to Yakusun, ruled not whisky" is the sentence, and a
 * bare id is not one.
 */
export interface ReviewInertHits {
  /**
   * Bottlings whose own spelling reaches a producer somebody has ruled out.
   */
  rejected: Map<ID, KbProducerFacts>;

  /**
   * Bottlings whose spelling reaches a producer still withheld from the
   * resolver. Promoting it takes them all out of the queue at once.
   */
  withheld: Map<ID, KbProducerFacts>;
}

/**
 * The same answer flattened to the two id lists the detector query reads.
 */
export interface ReviewInertHitIds {
  /**
   * Bottlings reaching a `rejected` producer.
   */
  rejected: ID[];

  /**
   * Bottlings reaching a withheld one.
   */
  withheld: ID[];
}

/**
 * What the curation queue's one counting statement answers.
 */
export interface ReviewIssueCounts {
  /**
   * Bottlings in the queue under the filters asked for.
   */
  open: number;

  /**
   * Of those, how many carry a contradiction and nothing else.
   */
  conflictOnly: number;

  /**
   * How many carry each code. Codes overlap, so these never sum to `open`.
   */
  byIssue: Record<string, number>;
}

/**
 * One reason a bottling is in the queue.
 */
export interface ReviewIssue {
  /**
   * Which detector fired.
   */
  code: ReviewIssueCode;

  /**
   * How badly it wants attention, from the one severity map the client
   * colours its chips by.
   */
  severity: ReviewIssueSeverity;

  /**
   * The fact the issue is about, when it is about one — `type`, `country`,
   * `abv`, `volume`, `age`, `name` or `producer`.
   */
  field?: string;

  /**
   * What the detector found, for the codes that have something to say: the
   * type a name states, the producer an inert row would claim.
   */
  detail?: string;

  /**
   * The producer `detail` names, for the two codes whose answer is a row a
   * reviewer has to open rather than a word.
   */
  producerId?: ID;
}

/**
 * One reason a producer is in the queue.
 *
 * A shape of its own rather than a reuse of {@link ReviewIssue}, because the
 * two queues answer different questions and share no code: a bottling is
 * wrong, a producer is unreachable or unresearched. They share the severity
 * vocabulary, so one legend explains both tabs.
 */
export interface ProducerIssue {
  /**
   * Which detector fired.
   */
  code: ProducerIssueCode;

  /**
   * How badly it wants attention.
   */
  severity: ReviewIssueSeverity;
}

/**
 * One shop's listing of a bottling, as the evidence card reads it.
 */
export interface ReviewOffer {
  /**
   * The offer's own id — what a relink moves.
   */
  id: ID;

  /**
   * The shop's slug.
   */
  storeSlug: string;

  /**
   * The shop's display name.
   */
  storeName: string;

  /**
   * The shop's colour, so a monogram is recognisable at a glance.
   */
  storeColor: string | null;

  /**
   * The shop's own article number.
   */
  sku: string;

  /**
   * The shop's own name for the listing — the string every fact was read out
   * of, and what a wrong canonical name is compared against.
   */
  nameOrig: string;

  /**
   * The listing's page.
   */
  url: string;

  /**
   * Whether the shop currently sells it.
   */
  inStock: boolean;

  /**
   * The most recent price captured, or null when none was.
   */
  price: number | null;

  /**
   * When the catalogue first saw this listing.
   */
  firstSeen: string | null;

  /**
   * The brand the raw name states inside a trademark token, when it does —
   * the `ТМ Hyde` that no field carries and the producer suggestion is built
   * from.
   */
  brandHint: string | null;
}

/**
 * One shop's claim that contradicts a stored fact.
 */
export interface ReviewConflict {
  /**
   * The shop making the claim.
   */
  storeId: ID;

  /**
   * Its slug.
   */
  storeSlug: string;

  /**
   * Which fact is disputed.
   */
  attribute: string;

  /**
   * What the shop says, resolved to a readable label.
   */
  claimed: string;

  /**
   * What the catalogue holds, likewise.
   */
  stored: string;

  /**
   * Where the stored value came from.
   */
  storedSource: string | null;

  /**
   * How many times the claim has arrived.
   */
  seenCount: number;

  /**
   * When it last did.
   */
  lastSeenAt: Date | null;

  /**
   * When somebody acknowledged it, or null while it is open. A re-sighting no
   * longer clears this — see the design's §3.2.
   */
  resolvedAt: Date | null;
}

/**
 * A producer as the curation screen names one.
 */
export interface ReviewProducerRef {
  /**
   * The producer's id.
   */
  id: ID;

  /**
   * Its slug, which is also the token the match key is signed with.
   */
  slug: string;

  /**
   * Its display name.
   */
  name: string;

  /**
   * Which kind of maker it is.
   */
  kind: ProducerKind;

  /**
   * How far it has been reviewed.
   */
  status: KbStatus;
}

/**
 * One bottling in the curation queue: its facts with their provenance, the
 * evidence behind them, and why it is here.
 */
export interface ReviewQueueRow {
  /**
   * The bottling.
   */
  id: ID;

  /**
   * Its canonical name, or null when cleaning left nothing.
   */
  name: string | null;

  /**
   * The longest raw name any shop uses, as the display fallback.
   */
  nameOrig: string | null;

  /**
   * The frozen match key. Nowhere else in the API, and this is the only cheap
   * moment to notice a wrong one.
   */
  matchKey: string | null;

  /**
   * Age statement in years, or null for a NAS bottling.
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
   * Pack size in millilitres.
   */
  volumeMl: number | null;

  /**
   * Where the pack size came from.
   */
  volumeSource: string | null;

  /**
   * Whisky type name.
   */
  type: string | null;

  /**
   * Where the type came from.
   */
  typeSource: string | null;

  /**
   * ISO country code.
   */
  countryCode: string | null;

  /**
   * The country's Ukrainian name.
   */
  countryName: string | null;

  /**
   * The country's flag.
   */
  countryIcon: string | null;

  /**
   * Where the country came from.
   */
  countrySource: string | null;

  /**
   * The distillery, brand or blend the bottling resolves to.
   */
  producer: ReviewProducerRef | null;

  /**
   * The independent bottler that released it.
   */
  bottler: ReviewProducerRef | null;

  /**
   * Where the producer link came from; `manual` means a person pinned it and
   * no pass may move it.
   */
  producerSource: string | null;

  /**
   * The spelling a shop used for the maker. A null producer beside a non-null
   * value here is "the knowledge base does not know this maker yet".
   */
  brandOrig: string | null;

  /**
   * The bottling's flavour tags.
   */
  flavors: string[];

  /**
   * How many shops stock it.
   */
  storeCount: number;

  /**
   * Every shop's listing, in-stock first.
   */
  offers: ReviewOffer[];

  /**
   * The cross-shop contradictions recorded against it.
   */
  conflicts: ReviewConflict[];

  /**
   * Why it is in the queue, worst first.
   */
  issues: ReviewIssue[];

  /**
   * Its place in the queue, or null for a bottling that predates it.
   */
  reviewStatus: ProductReviewStatus | null;

  /**
   * When a person last decided about it.
   */
  reviewedAt: Date | null;

  /**
   * When the catalogue created it.
   */
  createdAt: Date;
}

/**
 * What narrows a page of the curation queue.
 */
export interface ReviewQueueQuery {
  /**
   * Keep only bottlings carrying at least one of these codes.
   */
  issue?: string[];

  /**
   * Keep only bottlings at least one of these shops lists.
   */
  store?: string[];

  /**
   * Case-insensitive substring of the canonical name, any shop's raw name, or
   * a listing URL.
   */
  name?: string;

  /**
   * Which slice: the work, or one of the two decision logs.
   */
  status?: ReviewQueueStatus;

  /**
   * How to order the page.
   */
  sort?: ReviewQueueSort;

  /**
   * Include bottlings no shop stocks. Off by default — a bottling nobody
   * sells is not work.
   */
  includeUnstocked?: boolean;

  /**
   * Count acknowledged contradictions too, which is what the «переглянуті
   * розбіжності» checkbox turns on.
   */
  includeAcknowledged?: boolean;

  /**
   * Restrict to specific bottlings, whatever else the filters say. What a
   * commit reads its own row back with, so the issues it reports left are the
   * detectors' answer rather than a second opinion.
   */
  productIds?: ID[];

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
 * The counters the screen's tabs and its «Проблеми» dropdown badge themselves
 * with.
 */
export interface ReviewSummary {
  /**
   * Bottlings waiting for a person.
   */
  open: number;

  /**
   * Bottlings verified today — the "you have done this much" number.
   */
  verifiedToday: number;

  /**
   * Bottlings ruled out, ever.
   */
  rejected: number;

  /**
   * Of the open ones, how many are here for a contradiction and nothing else.
   */
  conflictOnly: number;

  /**
   * How many open bottlings each code fires on. Codes overlap, so these never
   * sum to `open`.
   */
  byIssue: Record<string, number>;

  /**
   * When the knowledge base was last applied to the catalogue, so the toolbar
   * can say so.
   */
  knowledgeBaseAppliedAt: Date | null;

  /**
   * The producers queue's own counters.
   */
  producers: ReviewProducerSummary;
}

/**
 * The producers queue's counters.
 */
export interface ReviewProducerSummary {
  /**
   * Producers waiting for a person.
   */
  open: number;

  /**
   * How many each code fires on.
   */
  byIssue: Record<string, number>;
}

/**
 * How a producer candidate was found, which is what the suggestion states
 * beside it.
 */
export type ReviewCandidateVia =
  | 'brandOrig'
  | 'tm-token'
  | 'name-word'
  | 'unreachable-alias'
  | 'similar';

/**
 * One producer the bottling might belong to.
 */
export interface ReviewProducerCandidate {
  /**
   * The producer.
   */
  producer: ReviewProducerRef;

  /**
   * Its country's flag, so the candidate reads at a glance.
   */
  countryIcon: string | null;

  /**
   * How it was found.
   */
  via: ReviewCandidateVia;

  /**
   * The spelling that found it — what an alias would be minted from.
   */
  spelling: string;

  /**
   * How many bottlings already resolve to it, as a confidence signal.
   */
  productCount: number;
}

/**
 * How a duplicate candidate was found.
 */
export type ReviewDuplicateVia = 'identity' | 'near-identity';

/**
 * A bottling this one may be a second copy of.
 */
export interface ReviewDuplicateCandidate {
  /**
   * The other bottling.
   */
  productId: ID;

  /**
   * Its name.
   */
  name: string | null;

  /**
   * Its pack size.
   */
  volumeMl: number | null;

  /**
   * Its age statement.
   */
  age: number | null;

  /**
   * How many shops stock it, which is usually what decides the survivor.
   */
  storeCount: number;

  /**
   * How it was found.
   */
  via: ReviewDuplicateVia;
}

/**
 * One value a bottling's siblings carry, with how many carry it.
 */
export interface ReviewSiblingValue {
  /**
   * The value, as the patch would state it: a number for the strength, a type
   * name, an ISO country code.
   */
  value: string;

  /**
   * How it reads on screen.
   */
  label: string;

  /**
   * How many identically-named bottlings state it.
   */
  count: number;
}

/**
 * What identically-named bottlings say about the facts this one lacks — the
 * `Canadian Club Original is 40 % in seven other shops` suggestion.
 */
export interface ReviewSiblings {
  /**
   * Strengths, most common first.
   */
  abv: ReviewSiblingValue[];

  /**
   * Whisky types.
   */
  type: ReviewSiblingValue[];

  /**
   * Countries, valued by ISO code.
   */
  country: ReviewSiblingValue[];
}

/**
 * Everything the side panel loads when a bottling is opened.
 */
export interface ReviewSuggestions {
  /**
   * Producers the bottling might belong to, best first.
   */
  producers: ReviewProducerCandidate[];

  /**
   * Bottlings it might be a duplicate of.
   */
  duplicates: ReviewDuplicateCandidate[];

  /**
   * What its namesakes say about the facts it lacks.
   */
  siblings: ReviewSiblings;

  /**
   * Tokens lifted out of the shops' listing URLs, which often carry a
   * correctly-spelled name the listing itself truncated.
   */
  storeHints: string[];
}

/**
 * One fact an action would change.
 */
export interface ReviewFactChange {
  /**
   * What the bottling holds now, or null when it holds nothing.
   */
  from: string | null;

  /**
   * What the action would write.
   */
  to: string | null;
}

/**
 * One bottling an action would touch beyond the one being edited.
 */
export interface ReviewAffected {
  /**
   * The bottling.
   */
  productId: ID;

  /**
   * Its name.
   */
  name: string | null;

  /**
   * Its pack size.
   */
  volumeMl: number | null;

  /**
   * Its age statement.
   */
  age: number | null;

  /**
   * The shops that list it.
   */
  stores: string[];

  /**
   * Whether it is in the queue today.
   */
  inQueue: boolean;

  /**
   * Its place in the queue.
   */
  reviewStatus: ProductReviewStatus | null;

  /**
   * What the action would change about it.
   */
  changes: ReviewAffectedChanges;
}

/**
 * The three facts a producer action can move.
 */
export interface ReviewAffectedChanges {
  /**
   * The maker, by display name.
   */
  producer?: ReviewFactChange;

  /**
   * The whisky type.
   */
  type?: ReviewFactChange;

  /**
   * The country, by Ukrainian name.
   */
  country?: ReviewFactChange;
}

/**
 * What one alias scope would do to the catalogue.
 */
export interface ReviewAliasScopeReach {
  /**
   * Bottlings that resolve to nothing today and would leave the queue — the
   * open one included, so «Лише ця пляшка» reads 1.
   */
  frees: number;

  /**
   * Bottlings that resolve to a **different** producer today and would be
   * re-pointed. The danger number.
   */
  steals: number;
}

/**
 * What an action would do before it is taken.
 */
export interface ReviewPreview {
  /**
   * The bottlings it would change, at most a screenful.
   */
  affected: ReviewAffected[];

  /**
   * How many there are in total, which the counts are taken from.
   */
  affectedTotal: number;

  /**
   * How many would leave the queue and how many would be taken from another
   * producer — the two numbers the binding block states.
   */
  reach: ReviewAliasScopeReach;

  /**
   * The same two numbers for each scope an alias could have, so the narrowest
   * one that fixes the queue is visible before it is chosen. Absent for an
   * action that writes no alias.
   */
  aliasScopes?: Record<string, ReviewAliasScopeReach>;
}

/**
 * How a commit links a bottling to its maker.
 *
 * Three shapes rather than one nullable field, because they reach different
 * numbers of bottlings and the person picked which: a pin touches this
 * bottling only, an alias touches every bottling carrying the spelling, and
 * widening an existing alias touches whatever the wider scope now matches.
 */
export interface ReviewProducerLink {
  /**
   * Which way the link is made.
   */
  mode: 'pin' | 'alias' | 'widen-alias';

  /**
   * The producer to point at. Required for `pin` and `alias`; null on a `pin`
   * clears the link.
   */
  producerId?: ID | null;

  /**
   * The bottler to point at, for a `pin`. Null clears it.
   */
  bottlerId?: ID | null;

  /**
   * The spelling to mint, for `alias`.
   */
  spelling?: string;

  /**
   * The alias to widen, for `widen-alias`.
   */
  aliasId?: ID;

  /**
   * The scope the alias takes.
   */
  scope?: string;
}

/**
 * The facts a commit writes, each stamped `manual`.
 */
export interface ReviewPatch {
  /**
   * The canonical name.
   */
  name?: string | null;

  /**
   * The whisky type, by name.
   */
  typeName?: string | null;

  /**
   * The country, by ISO code.
   */
  countryCode?: string | null;

  /**
   * The strength.
   */
  abv?: number | null;

  /**
   * The pack size.
   */
  volumeMl?: number | null;

  /**
   * The age statement. Part of the bottling's identity, so writing it may
   * merge.
   */
  age?: number | null;

  /**
   * The flavour tags, replacing the whole set and marking it curated.
   */
  flavors?: string[];
}

/**
 * Everything a person decided about one bottling, in one request.
 */
export interface ReviewCommitInput {
  /**
   * The bottling.
   */
  productId: ID;

  /**
   * The verdict. Always written, so the bottling leaves the queue whatever
   * else the request carries.
   */
  verdict: ProductReviewStatus;

  /**
   * The facts to change.
   */
  patch?: ReviewPatch;

  /**
   * Facts to stamp `manual` without changing — "this value is right", which
   * is what stops the next sync or knowledge-base pass from moving it.
   */
  confirm?: string[];

  /**
   * How to link the maker.
   */
  producer?: ReviewProducerLink;
}

/**
 * What a commit did.
 */
export interface ReviewCommitResult {
  /**
   * The bottling the decision landed on — not necessarily the one asked
   * about, since an edit can merge.
   */
  productId: ID;

  /**
   * Whether the bottling was folded into another.
   */
  merged: boolean;

  /**
   * Whether an alias action created a producer.
   */
  created: boolean;

  /**
   * Which detectors still fire on the survivor, so the client can say the
   * work is or is not finished.
   */
  issuesLeft: string[];

  /**
   * The other bottlings the action changed, so the toast can repeat the
   * reach.
   */
  affected: ReviewAffected[];

  /**
   * How many there were in total.
   */
  affectedTotal: number;
}

/**
 * An explicit merge of one bottling into another.
 */
export interface ReviewMergeInput {
  /**
   * The bottling that vanishes; its key is retired into an alias.
   */
  sourceId: ID;

  /**
   * The bottling that survives.
   */
  targetId: ID;
}

/**
 * One fact written across a selection, every value stamped `manual`.
 */
export interface ReviewBulkInput {
  /**
   * The bottlings.
   */
  productIds: ID[];

  /**
   * The whisky type to write.
   */
  typeName?: string;

  /**
   * The country to write, by ISO code.
   */
  countryCode?: string;

  /**
   * The producer to pin.
   */
  producerId?: ID;
}

/**
 * What a bulk write did.
 */
export interface ReviewBulkResult {
  /**
   * How many bottlings were written.
   */
  updated: number;
}

/**
 * One producer in the curation queue.
 */
export interface ProducerQueueRow {
  /**
   * The producer.
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
   * Which kind of maker it is.
   */
  kind: ProducerKind;

  /**
   * How far it has been reviewed.
   */
  status: KbStatus;

  /**
   * Its country's ISO code.
   */
  countryCode: string | null;

  /**
   * Its country's Ukrainian name.
   */
  countryName: string | null;

  /**
   * Its country's flag.
   */
  countryIcon: string | null;

  /**
   * Its common region.
   */
  region: string | null;

  /**
   * The type every bottling of it is, when it has one.
   */
  defaultTypeName: string | null;

  /**
   * Its peat band.
   */
  peatProfile: string;

  /**
   * How many bottlings resolve to it today.
   */
  productCount: number;

  /**
   * How many spellings reach it.
   */
  aliasCount: number;

  /**
   * How many unresolved stocked bottlings carry its name in a raw listing
   * name — the work an alias would clear.
   */
  unresolvedMentions: number;

  /**
   * How many bottlings would resolve to it if the whole withheld queue went
   * live — the only usable ranking for a producer the resolver ignores,
   * whose `productCount` is structurally zero. Null for a live producer,
   * where `productCount` is already a real answer.
   */
  potentialReach: number | null;

  /**
   * Why it is in the queue, worst first.
   */
  issues: ProducerIssue[];

  /**
   * When it was created.
   */
  createdAt: Date;
}

/**
 * One bottling that resolves to no maker, as the producer hints read it.
 */
export interface ProductUnresolvedNameRow {
  /**
   * The bottling.
   */
  id: ID;

  /**
   * Its canonical name — what the resolver read and failed on.
   */
  name: string | null;

  /**
   * Every shop's raw name joined, which still carries what the cleaner
   * stripped.
   */
  raw: string;
}

/**
 * Everything the per-bottling suggestions are derived from.
 */
export interface ProductSuggestionSourceRow {
  /**
   * The bottling.
   */
  id: ID;

  /**
   * Its canonical name.
   */
  name: string | null;

  /**
   * The spelling a shop used for the maker.
   */
  brandOrig: string | null;

  /**
   * Its pack size.
   */
  volumeMl: number | null;

  /**
   * Its age statement.
   */
  age: number | null;

  /**
   * The resolved maker, or null.
   */
  producerId: ID | null;

  /**
   * The resolved bottler, or null.
   */
  bottlerId: ID | null;

  /**
   * Every shop's raw name for it.
   */
  rawNames: string[];

  /**
   * Every shop's listing URL.
   */
  urls: string[];
}

/**
 * One value identically-named bottlings state about one fact.
 */
export interface ProductSiblingFactRow {
  /**
   * Which fact: `abv`, `type` or `country`.
   */
  fact: string;

  /**
   * The value, as a patch would state it.
   */
  value: string;

  /**
   * How it reads on screen.
   */
  label: string;

  /**
   * How many namesakes state it.
   */
  n: number;
}

/**
 * What the what-if pass concluded about the producers themselves.
 *
 * Both lists are computed in TypeScript, over the same `KbAliasUtils` rules
 * the resolver matches by — which is why they are handed to the detector query
 * rather than reimplemented in it.
 */
export interface ProducerQueueHints {
  /**
   * Live producers whose every spelling is unreachable by name while some
   * unresolved stocked bottling carries the word. One scope change fixes every
   * such bottling at once.
   */
  unreachable: ID[];

  /**
   * Producers named in the raw listing names of bottlings that resolve to
   * nothing.
   */
  mentioned: ID[];

  /**
   * How many such bottlings each producer is named in.
   */
  mentions: Map<ID, number>;
}

/**
 * What narrows a page of the producers queue.
 */
export interface ProducerQueueQuery {
  /**
   * Keep only producers carrying at least one of these codes.
   */
  issue?: string[];

  /**
   * Keep only one review status.
   */
  status?: KbStatus;

  /**
   * Keep only one kind of maker.
   */
  kind?: ProducerKind;

  /**
   * Case-insensitive substring of the name or the slug.
   */
  name?: string;

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
 * One producer issue code with the codes it is reported under, used by the
 * producers queue's own filter chips.
 */
export type ProducerIssueCounts = Record<ProducerIssueCode, number>;
