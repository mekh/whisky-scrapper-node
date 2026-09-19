import type {
  FlavorRuleMatchMode,
  KbFlavorEffect,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { ID } from '~types';

/**
 * The producer columns the resolver reads, shared by the alias-index read and
 * the by-id facts read.
 */
export interface KbProducerRow {
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
 * One row of the alias-index read: the alias columns plus the producer columns
 * the resolver needs, flattened by the join.
 */
export interface KbAliasRow extends KbProducerRow {
  /**
   * The normalized alias.
   */
  key: string;
  /**
   * Where the alias may be matched.
   */
  scope: ProducerAliasScope;
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

/**
 * One producers-queue row exactly as the detector query returns it.
 *
 * Internal to `core/producer`: the service turns it into a
 * {@link ProducerQueueRow}, adding the severity each code carries and the
 * mention count the what-if pass computed — both of which are TypeScript's to
 * add, from the one severity map the client also reads and from the alias
 * rules the resolver matches by.
 */
export interface ProducerQueueSqlRow {
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
   * How many bottlings resolve to it, in either slot.
   */
  productCount: number;

  /**
   * How many spellings reach it.
   */
  aliasCount: number;

  /**
   * The codes that fired, as bare strings.
   */
  issues: string[];

  /**
   * When it was created.
   */
  createdAt: Date;
}

/**
 * The facts a suggested producer is judged by, beyond what the alias index
 * carries.
 */
export interface ProducerCandidateFactRow {
  /**
   * The producer.
   */
  id: ID;

  /**
   * Its review status, so a withheld candidate can be marked as one.
   */
  status: KbStatus;

  /**
   * Its country's flag.
   */
  countryIcon: string | null;

  /**
   * How many bottlings already resolve to it, in either slot.
   */
  productCount: number;
}
