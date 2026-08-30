import type {
  FlavorRuleMatchMode,
  KbFlavorEffect,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { ID } from '~types';

/**
 * One row of the alias-index read: the alias columns plus the producer columns
 * the resolver needs, flattened by the join.
 */
export interface KbAliasRow {
  /**
   * The normalized alias.
   */
  key: string;
  /**
   * Where the alias may be matched.
   */
  scope: ProducerAliasScope;
  /**
   * Producer id.
   */
  id: ID;
  /**
   * Producer slug.
   */
  slug: string;
  /**
   * Producer display name.
   */
  name: string;
  /**
   * Producer kind.
   */
  kind: ProducerKind;
  /**
   * Country FK, or null.
   */
  countryId: ID | null;
  /**
   * Common region, or null.
   */
  region: ScotlandRegion | null;
  /**
   * Protected SWA region, or null.
   */
  legalRegion: ScotlandLegalRegion | null;
  /**
   * Parent distillery of a brand row, or null.
   */
  parentId: ID | null;
  /**
   * Owning bottler, or null.
   */
  bottlerId: ID | null;
  /**
   * Default whisky type name, or null.
   */
  defaultTypeName: string | null;
  /**
   * House peat profile.
   */
  peatProfile: PeatProfile;
}

/**
 * One row of the rules read.
 */
export interface KbFlavorRuleRow {
  /**
   * Scoping producer, or null for a global rule.
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
   * Tag the rule acts on, or null on a peat rule.
   */
  flavorId: ID | null;
  /**
   * Tag effect, or null on a peat rule.
   */
  effect: KbFlavorEffect | null;
  /**
   * Peat level implied, or null on a tag rule.
   */
  peatProfile: PeatProfile | null;
  /**
   * Rule priority; higher wins.
   */
  priority: number;
}
