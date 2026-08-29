import type {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';

/**
 * Status filter and paging for the producers tab.
 */
export interface ReviewProducerQuery {
  /**
   * Restrict to one review status, or omit for all.
   */
  status?: KbStatus;

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
   * 1-based page number.
   */
  page?: number;

  /**
   * Page size.
   */
  perPage?: number;
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
