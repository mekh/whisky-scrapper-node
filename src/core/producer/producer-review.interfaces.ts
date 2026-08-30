import type {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';

/**
 * A reviewer's edit as the repository takes it.
 *
 * "Absent" and "deliberately empty" are different intentions, and one nullable
 * field cannot carry both — a reviewer correcting a peat band must not wipe an
 * owner they never looked at. So the nullable fields come in pairs: the value,
 * and an explicit flag that says to clear it.
 */
export interface ProducerReviewPatch {
  /**
   * Display name.
   */
  name?: string;

  /**
   * What kind of producer this is.
   */
  kind?: ProducerKind;

  /**
   * ISO country code. An unknown code leaves the country untouched rather
   * than nulling it, so a typo cannot erase a fact.
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
   * Review status. Writing `verified` takes a withheld row live.
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
