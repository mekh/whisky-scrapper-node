import type { ID } from '~types';

/**
 * Parsed command-line options of the load-test seed script.
 */
export interface LoadtestSeedOptions {
  /**
   * Remove the seeded users and revoke their sessions instead of creating
   * them.
   */
  cleanup: boolean;

  /**
   * How many users to create.
   */
  users: number;

  /**
   * Name prefix every seeded user carries; also what `--cleanup` deletes by.
   */
  prefix: string;

  /**
   * Path of the JSON file the users and their tokens are written to.
   */
  out: string;

  /**
   * Access-token lifetime in seconds, or undefined for the configured
   * `JWT_ACCESS_EXPIRES`.
   */
  accessTtl?: number;

  /**
   * Whether a share of the users also gets favourites, blacklist entries,
   * quick filters and collection rows.
   */
  prefs: boolean;
}

/**
 * One seeded user as k6 reads it: identity, the address it presents, and a
 * live token pair.
 */
export interface LoadtestUserRecord {
  /**
   * One-based position in the seed, which also seeds the user's random
   * preferences.
   */
  index: number;

  /**
   * The user's id.
   */
  id: ID;

  /**
   * The login name, `<prefix><index>`.
   */
  name: string;

  /**
   * The client address this user presents through `X-Real-IP`, so the API
   * sees one caller per user.
   */
  ip: string;

  /**
   * A signed access token whose session exists in Valkey.
   */
  access: string;

  /**
   * The matching refresh token, `userId.sid.secret`.
   */
  refresh: string;

  /**
   * The access token's `exp` claim, epoch seconds.
   */
  accessExp: number;
}

/**
 * The file the seed writes and k6 loads.
 */
export interface LoadtestUsersFile {
  /**
   * When the seed ran, ISO 8601.
   */
  createdAt: string;

  /**
   * The name prefix the users were created with.
   */
  prefix: string;

  /**
   * The one password every seeded user shares, for the live-login persona.
   */
  password: string;

  /**
   * The access-token lifetime the tokens were signed with, or null when the
   * configured default applied.
   */
  accessTtlSec: number | null;

  /**
   * The users, ordered by index.
   */
  users: LoadtestUserRecord[];
}

/**
 * How many personalisation rows the seed wrote.
 */
export interface LoadtestPrefsTally {
  /**
   * Favourite rows written.
   */
  favorites: number;

  /**
   * Hidden bottlings written.
   */
  blacklistProducts: number;

  /**
   * Hidden producers written.
   */
  blacklistProducers: number;

  /**
   * Saved filter sets written.
   */
  quickFilters: number;

  /**
   * Collection rows written.
   */
  collectionRows: number;

  /**
   * Purchases written under those rows.
   */
  purchases: number;
}

/**
 * The catalogue rows the random preferences are drawn from.
 */
export interface LoadtestCatalogueSample {
  /**
   * Canonical bottling ids.
   */
  productIds: ID[];

  /**
   * Ids of live producers, for brand blacklist entries.
   */
  producerIds: ID[];
}
