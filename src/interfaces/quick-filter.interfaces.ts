import { ID } from './entity.interfaces';

/**
 * A saved filter set's payload, as stored and as returned — an **opaque**
 * object the backend never interprets.
 *
 * The keys are the client's own filter dimensions (`stores`, `countries`,
 * `minPrice`, …). The backend validates only the payload's *shape* (see the
 * `FilterPayload` field decorator): size, key count, and that every value is a
 * scalar or a flat array of scalars. It deliberately does not know which
 * dimensions exist, so shipping a new filter dimension needs no backend change
 * and an older backend still accepts and returns a newer client's payload
 * verbatim. The consuming report endpoint validates each dimension for real.
 */
export type QuickFilterPayload = Record<string, unknown>;

/**
 * One named filter set belonging to one user.
 */
export interface QuickFilter {
  /**
   * The set's own id, used to update or delete it.
   */
  id: ID;

  /**
   * The user-chosen name. Unique per user, whitespace-normalized on write, and
   * compared case-insensitively — two sets differing only in case are a
   * duplicate.
   */
  name: string;

  /**
   * The saved filters. Opaque to the backend — see {@link QuickFilterPayload}.
   */
  filters: QuickFilterPayload;

  /**
   * When the set was created.
   */
  createdAt: Date;

  /**
   * When the set was last renamed or had its filters replaced.
   */
  updatedAt: Date;
}

/**
 * Request shape for creating a filter set.
 */
export interface QuickFilterCreateInput {
  /**
   * The name to save it under. Must be unique among the user's sets.
   */
  name: string;

  /**
   * The filters to store. An empty object is valid — "show everything" is a
   * legitimate set.
   */
  filters: QuickFilterPayload;
}

/**
 * Request shape for updating a filter set. Both fields are independent: a
 * rename carries `name` alone and leaves the stored payload untouched, which
 * is what keeps an older client from destroying dimensions it cannot parse.
 */
export interface QuickFilterUpdateInput {
  /**
   * The new name, when renaming.
   */
  name?: string;

  /**
   * The replacement payload, when overwriting the filters.
   */
  filters?: QuickFilterPayload;
}
