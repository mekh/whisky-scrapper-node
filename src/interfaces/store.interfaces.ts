import { EntitySyncLog } from './entity.interfaces';

export interface StoreSlugParams {
  /**
   * Store slug from the route.
   */
  slug: string;
}

export interface StoreActiveInput {
  /**
   * Desired active state for the store.
   */
  active: boolean;
}

export interface StoreListItem {
  /**
   * Store id (uuid v7).
   */
  id: string;

  /**
   * Store slug.
   */
  slug: string;

  /**
   * Store display name.
   */
  name: string;

  /**
   * Store root URL.
   */
  baseUrl: string;

  /**
   * Brand color for the UI, when set.
   */
  color: string | null;

  /**
   * Whether the store is active.
   */
  active: boolean;

  /**
   * Scrape tier (1 = HTTP, 2 = Magento, 3 = browser), when configured.
   */
  tier: number | null;

  /**
   * Whether scraping needs a headless browser, when configured.
   */
  needsBrowser: boolean | null;

  /**
   * Zakaz.ua retail-chain slug, when applicable.
   */
  retailChain: string | null;

  /**
   * Zakaz.ua category slug, when applicable.
   */
  category: string | null;

  /**
   * Timestamp of the store's most recent successful sync, or null when it has
   * never synced successfully.
   */
  lastSuccessfulSyncAt: Date | null;
}

export interface StoreLastSync {
  /**
   * The store id.
   */
  storeId: string;

  /**
   * Timestamp of that store's most recent successful sync.
   */
  lastAt: Date;
}

export interface StoreDetail extends StoreListItem {
  /**
   * When the store first appeared (backfilled from earliest product).
   */
  createdAt: Date;

  /**
   * Number of products currently tracked for the store.
   */
  productCount: number;

  /**
   * Most recent sync-log entry, or null when the store never synced.
   */
  lastSync: EntitySyncLog | null;

  /**
   * The latest sync-log entries (most recent first).
   */
  recentSyncs: EntitySyncLog[];
}
