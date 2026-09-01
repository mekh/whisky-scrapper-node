import type { ID, ProductSnapshot } from '~types';

/**
 * A snapshot paired with the bottling it resolves to — the unit the write loop
 * works in, and what the run is sorted by.
 */
export interface ResolvedSnapshot {
  /**
   * The normalized snapshot.
   */
  snap: ProductSnapshot;

  /**
   * Its match key, or null when nothing about the name could identify it.
   */
  matchKey: string | null;
}

/**
 * The lookup-name-to-id maps a persist pass resolves once up front.
 */
export interface PersistLookups {
  /**
   * Whisky-type name to id.
   */
  typeIds: Map<string, ID>;

  /**
   * Lower-cased Ukrainian country name to id.
   */
  countryIds: Map<string, ID>;
}

/**
 * The bottlings a run resolved its new SKUs to.
 */
export interface CanonicalResolution {
  /**
   * Slot (match key, or a per-SKU slot for an unmatchable snapshot) to the
   * canonical id.
   */
  slots: Map<string, ID>;

  /**
   * How many of them this run created.
   */
  added: number;
}

/**
 * How many offers a persist pass stored, added and flagged out of stock, and
 * how many bottlings it introduced to the catalogue.
 */
export interface PersistCounts {
  /**
   * In-stock store offers upserted this pass.
   */
  stored: number;

  /**
   * How many of the stored offers were new. Counts offers, not bottlings, so
   * the number stays comparable with what `sync_log` recorded before the
   * catalogue was split out of the store rows.
   */
  added: number;

  /**
   * Bottlings this pass added to the catalogue — new offers whose match key
   * was not already stored. Far smaller than {@link added} once a store's
   * range overlaps the others, and the number that says whether matching is
   * working in production.
   */
  addedProducts: number;

  /**
   * Products marked out of stock this pass (rows are kept, never deleted).
   */
  removed: number;
}
