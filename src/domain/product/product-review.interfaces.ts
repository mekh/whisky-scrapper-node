import type {
  FlavorRuleMatchMode,
  KbFlavorEffect,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ProductReviewStatus,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { ID } from '~types';

/**
 * Status filter and paging for the producers tab.
 */
export interface ReviewProducerQuery {
  /**
   * Restrict to one review status, or omit for all.
   */
  status?: KbStatus;

  /**
   * Case-insensitive name search, or omit for all.
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
 * Field filter and paging for the facts tab.
 */
export interface ReviewFactQuery {
  /**
   * Restrict to `type` or `country`, or omit for either.
   */
  field?: string;

  /**
   * `resolved` or `unresolved` to take one half of the queue, or omit for
   * both. The two halves are different work: an unresolved bottling is a
   * symptom of the unresolved-producer problem and is cured a producer at a
   * time, while a resolved one is here because the knowledge base has already
   * said all it can.
   */
  producer?: string;

  /**
   * Case-insensitive name search, or omit for all.
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
 * Attribute and store filters, plus paging, for the conflicts tab.
 */
export interface ReviewConflictQuery {
  /**
   * Restrict to one disputed attribute.
   */
  attribute?: string;

  /**
   * Restrict to one shop's claims.
   */
  store?: string;

  /**
   * Case-insensitive name search, or omit for all.
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
 * Status filter and paging for the new-product queue.
 */
export interface ReviewQueueQuery {
  /**
   * Which bucket to list. Defaults to `pending` — the work. The other two are
   * the archive, and `rejected` is reachable for one reason that matters: it
   * is the only way back from a rejection somebody made by mistake.
   *
   * Deliberately a field of its own rather than a reuse of the producers tab's
   * `status`: that one is a {@link KbStatus}, whose `auto` means nothing here
   * and which has no `pending` at all.
   */
  reviewStatus?: ProductReviewStatus;

  /**
   * Case-insensitive name search over the canonical name or any shop's raw
   * one, or omit for all.
   */
  name?: string;

  /**
   * Restrict to bottlings one shop carries.
   */
  store?: string;

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
 * A reviewer's verdict on one or more bottlings.
 *
 * One input for all three transitions, because they differ only in the value
 * written — and "back into the queue" and "un-reject" are the same operation
 * as "verify" with a different one. Three endpoints writing one column would
 * be three places to forget the cache bump.
 */
export interface ProductReviewStatusInput {
  /**
   * The bottlings to decide about. Bulk from the start: a pass over a night's
   * arrivals is twenty decisions, and twenty requests against a 3-per-second
   * limiter would earn a 429 doing nothing unusual.
   */
  productIds: ID[];

  /**
   * The verdict to record.
   */
  reviewStatus: ProductReviewStatus;
}

/**
 * A reviewer's new name-pattern rule, as the request states it. Exactly one of
 * `peatProfile` or the `flavorName`/`effect` pair must be set — the XOR the
 * table's CHECK constraint enforces, validated in the domain layer so it
 * answers 400 rather than 500.
 */
export interface ProducerRuleCreateInput {
  /**
   * The pattern, in whatever spelling the reviewer typed; normalized to a
   * `KbKeyUtils.key` before it is stored.
   */
  pattern: string;

  /**
   * `word` (default) or `prefix` — the latter exists for Ukrainian
   * inflection.
   */
  matchMode?: FlavorRuleMatchMode;

  /**
   * The peat band, for a peat rule. Never `unknown`.
   */
  peatProfile?: PeatProfile;

  /**
   * The flavour tag name, for a tag rule. Resolved against the `flavor`
   * table; an unknown name is rejected rather than coined.
   */
  flavorName?: string;

  /**
   * `require` or `forbid`. Never `baseline`, which belongs to the house
   * style.
   */
  effect?: KbFlavorEffect;

  /**
   * Higher wins; defaults to 60, the producer-scoped convention.
   */
  priority?: number;

  /**
   * Why the rule exists.
   */
  note?: string;
}

/**
 * A reviewer's edit to a producer. Every field is optional; an absent one is
 * left exactly as it was.
 */
export interface ProducerPatchInput {
  /**
   * Display name.
   */
  name?: string;

  /**
   * What kind of producer this is.
   */
  kind?: ProducerKind;

  /**
   * ISO country code; an unknown code is rejected rather than nulled.
   */
  countryCode?: string;

  /**
   * Common region, `islands` included.
   */
  region?: ScotlandRegion;

  /**
   * Clear the common region.
   */
  clearRegion?: boolean;

  /**
   * The protected SWA region; never `islands`.
   */
  legalRegion?: ScotlandLegalRegion;

  /**
   * Clear the protected region.
   */
  clearLegalRegion?: boolean;

  /**
   * Owning company.
   */
  owner?: string;

  /**
   * Clear the owner.
   */
  clearOwner?: boolean;

  /**
   * The type every bottling of this producer is.
   */
  defaultTypeName?: string;

  /**
   * Clear the default type, for a range that spans several.
   */
  clearDefaultTypeName?: boolean;

  /**
   * The distillery or brand this row belongs to.
   */
  parentId?: ID;

  /**
   * Clear the parent link.
   */
  clearParent?: boolean;

  /**
   * The independent bottler whose range this row is.
   */
  bottlerId?: ID;

  /**
   * Clear the bottler link.
   */
  clearBottler?: boolean;

  /**
   * The peat band — the field the screen mostly exists for.
   */
  peatProfile?: PeatProfile;

  /**
   * Review status. Writing `verified` is what takes a withheld row live.
   */
  status?: KbStatus;

  /**
   * Space-separated citations.
   */
  sourceUrls?: string;

  /**
   * Free text: what was uncertain, what was decided and why.
   */
  note?: string;
}

/**
 * One spelling to point at a producer.
 */
export interface ProducerAliasInput {
  /**
   * The brand as a shop spells it. Normalized by `KbKeyUtils.key` before it
   * is stored, so a reviewer may paste the raw value.
   */
  brand: string;

  /**
   * Where the alias may be matched. Defaults to `any`.
   */
  scope?: ProducerAliasScope;

  /**
   * Why the alias exists.
   */
  note?: string;
}
