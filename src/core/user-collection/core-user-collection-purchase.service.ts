import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import type { CollectionTimelineGranularity } from '~enums';
import { NotFoundError } from '~errors';
import type {
  CollectionCountryBucket,
  CollectionPurchaseResolved,
  CollectionPurchaseRow,
  CollectionRegionBucket,
  CollectionStatsBounds,
  CollectionStatsPurchase,
  CollectionStoreBucket,
  CollectionSummaryRow,
  CollectionTimelineBucket,
  ID,
} from '~types';

import { UserCollectionPurchaseEntity } from './user-collection-purchase.entity';
import { UserCollectionPurchaseRepository } from './user-collection-purchase.repository';

/**
 * Persistence-layer public API for collection purchases: CRUD scoped to the
 * owning collection row, plus the aggregate reads behind the statistics
 * screen.
 *
 * Every method here is a thin pass-through to
 * {@link UserCollectionPurchaseRepository} — the SQL and mapping choices live
 * there. This class adds only the two things a repository must not decide on
 * its own: turning "nothing matched" into {@link NotFoundError}, and hiding
 * the raw sort-direction keyword behind two named methods so no caller ever
 * passes a SQL literal around.
 */
@Injectable()
export class CoreUserCollectionPurchaseService
  extends CoreBaseService<UserCollectionPurchaseEntity> {
  public constructor(
    protected readonly repo: UserCollectionPurchaseRepository,
  ) {
    super(repo);
  }

  /**
   * Loads every purchase of the given collection rows, oldest first.
   *
   * @param collectionIds - Collection rows to load purchases for.
   * @returns One row per purchase; empty when none have purchases.
   */
  public async findByCollectionIds(
    collectionIds: ID[],
  ): Promise<CollectionPurchaseRow[]> {
    return this.repo.findByCollectionIds(collectionIds);
  }

  /**
   * Records one purchase against a collection row.
   *
   * @param collectionId - The collection row the purchase belongs to.
   * @param values - The purchase's resolved columns.
   * @returns The new purchase's id.
   * @throws {ServerError} When the driver reports no generated id.
   */
  public async createForCollection(
    collectionId: ID,
    values: CollectionPurchaseResolved,
  ): Promise<ID> {
    return this.repo.insertForCollection(collectionId, values);
  }

  /**
   * Patches one purchase, scoped to the collection row it must belong to.
   *
   * @param collectionId - The owning collection row; a mismatch means the
   *   purchase is treated as not belonging to it.
   * @param id - The purchase to update.
   * @param values - The columns to change; an explicit `null` clears one, an
   *   absent key leaves it alone.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   collection row.
   */
  public async updateForCollection(
    collectionId: ID,
    id: ID,
    values: CollectionPurchaseResolved,
  ): Promise<void> {
    const updated = await this.repo.updateForCollection(
      id,
      collectionId,
      values,
    );

    if (!updated) {
      throw new NotFoundError('Purchase not found', { id });
    }
  }

  /**
   * Deletes one purchase, scoped to the collection row it must belong to.
   *
   * @param collectionId - The owning collection row; a mismatch means the
   *   purchase is treated as not belonging to it.
   * @param id - The purchase to delete.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   collection row.
   */
  public async deleteForCollection(collectionId: ID, id: ID): Promise<void> {
    const deleted = await this.repo.deleteForCollection(id, collectionId);

    if (!deleted) {
      throw new NotFoundError('Purchase not found', { id });
    }
  }

  /**
   * Counts the purchases recorded against one collection row.
   *
   * @param collectionId - The collection row to count.
   * @returns The number of purchases it holds.
   */
  public async countByCollection(collectionId: ID): Promise<number> {
    return this.repo.countByCollection(collectionId);
  }

  /**
   * The KPIs behind the statistics screen's summary tiles.
   *
   * @param userId - Whose collection to summarize.
   * @returns The summary row; zeros and a null `avgPrice` for an empty
   *   collection.
   */
  public async summaryForUser(userId: ID): Promise<CollectionSummaryRow> {
    return this.repo.summaryForUser(userId);
  }

  /**
   * The most expensive priced purchase in a user's collection.
   *
   * Wraps {@link UserCollectionPurchaseRepository.extremePurchaseForUser}
   * with the `DESC` direction, so nothing outside the repository ever
   * spells out a SQL sort keyword.
   *
   * @param userId - Whose collection to search.
   * @returns The dearest purchase, or null when nothing carries a price.
   */
  public async mostExpensiveForUser(
    userId: ID,
  ): Promise<CollectionStatsPurchase | null> {
    return this.repo.extremePurchaseForUser(userId, 'DESC');
  }

  /**
   * The cheapest priced purchase in a user's collection.
   *
   * Wraps {@link UserCollectionPurchaseRepository.extremePurchaseForUser}
   * with the `ASC` direction, for the same reason as
   * {@link mostExpensiveForUser}.
   *
   * @param userId - Whose collection to search.
   * @returns The cheapest purchase, or null when nothing carries a price.
   */
  public async cheapestForUser(
    userId: ID,
  ): Promise<CollectionStatsPurchase | null> {
    return this.repo.extremePurchaseForUser(userId, 'ASC');
  }

  /**
   * Bottles and distinct whiskies of a user's collection, grouped by country
   * of origin.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per country, largest bottle count first; a bottling
   *   whose country never resolved falls under `unknown`.
   */
  public async countByCountryForUser(
    userId: ID,
  ): Promise<CollectionCountryBucket[]> {
    return this.repo.countByCountryForUser(userId);
  }

  /**
   * Bottles and distinct whiskies of a user's collection, grouped by
   * Scotland region. Scotch only — a bottling whose country is not Scotland
   * is absent entirely, not folded into `unknown`.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per region, largest bottle count first; a Scotch
   *   whose distillery never resolved falls under `unknown`.
   */
  public async countByRegionForUser(
    userId: ID,
  ): Promise<CollectionRegionBucket[]> {
    return this.repo.countByRegionForUser(userId);
  }

  /**
   * Bottles and spend of a user's collection, grouped by shop.
   *
   * @param userId - Whose collection to group.
   * @returns One bucket per known store plus one per distinct free-text
   *   shop name, largest bottle count first.
   */
  public async countByStoreForUser(
    userId: ID,
  ): Promise<CollectionStoreBucket[]> {
    return this.repo.countByStoreForUser(userId);
  }

  /**
   * The "bottles added over time" series, dense over the requested range: a
   * period with no purchases still comes back, with zeros.
   *
   * @param userId - Whose purchases to bucket.
   * @param from - First month of the range (`YYYY-MM`).
   * @param to - Last month of the range (`YYYY-MM`).
   * @param granularity - Bucket width.
   * @returns One bucket per period in `[from, to]`, ascending.
   */
  public async timelineForUser(
    userId: ID,
    from: string,
    to: string,
    granularity: CollectionTimelineGranularity,
  ): Promise<CollectionTimelineBucket[]> {
    return this.repo.timelineForUser(userId, from, to, granularity);
  }

  /**
   * The months a user's purchases span.
   *
   * @param userId - Whose purchases to bound.
   * @returns The first and last purchase month, or null when the user has
   *   recorded no purchases at all.
   */
  public async boundsForUser(
    userId: ID,
  ): Promise<CollectionStatsBounds | null> {
    return this.repo.boundsForUser(userId);
  }
}
