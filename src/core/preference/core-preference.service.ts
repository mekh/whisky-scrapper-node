import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { PreferenceRepository } from './preference.repository';

import type { ID, Preference, PreferenceBlacklistIds } from '~types';

/**
 * Persistence-layer public API for a user's favorites and blacklist. Does not
 * extend {@link CoreBaseService}: the rows it owns are composite-keyed
 * memberships with no surrogate id, so the generic CRUD surface has nothing to
 * offer them.
 */
@Injectable()
export class CorePreferenceService {
  /**
   * Deduplicates and sorts ids so concurrent transactions of the same user take
   * their row locks in one agreed order — the reason `setManualFlavors` sorts.
   * Deduplicating also keeps `ON CONFLICT DO NOTHING` from doing needless work
   * and, for inserts, satisfies Postgres' rule that a conflict target must not
   * repeat within one statement.
   *
   * @param ids - Raw ids from a request.
   * @returns The same ids, distinct and ascending.
   */
  private static normalize(ids: ID[]): ID[] {
    return [...new Set(ids)].sort();
  }

  public constructor(private readonly repo: PreferenceRepository) {}

  /**
   * Loads a user's complete preference set.
   *
   * @param userId - Whose preferences to read.
   * @returns The three lists; each is empty when the user has no entries.
   */
  public async findByUserId(userId: ID): Promise<Preference> {
    return this.repo.findByUserId(userId);
  }

  /**
   * Adds favorites, ignoring the ones already there.
   *
   * @param userId - Whose favorites to extend.
   * @param productIds - Canonical product ids to favorite.
   * @returns The user's preferences after the change.
   */
  public async addFavorites(
    userId: ID,
    productIds: ID[],
  ): Promise<Preference> {
    await this.repo.addFavorites(
      userId,
      CorePreferenceService.normalize(productIds),
    );

    return this.repo.findByUserId(userId);
  }

  /**
   * Removes favorites; ids that were never favorited are ignored.
   *
   * @param userId - Whose favorites to trim.
   * @param productIds - Canonical product ids to unfavorite.
   * @returns The user's preferences after the change.
   */
  public async removeFavorites(
    userId: ID,
    productIds: ID[],
  ): Promise<Preference> {
    await this.repo.removeFavorites(
      userId,
      CorePreferenceService.normalize(productIds),
    );

    return this.repo.findByUserId(userId);
  }

  /**
   * Hides bottlings and/or brands from every report, and drops the newly hidden
   * bottlings from the user's favorites — a whisky cannot sensibly be both
   * favorite and hidden, and the report would show the contradiction as a
   * favorite that is never listed.
   *
   * Note the asymmetry: hiding a *brand* leaves favorites alone. A favorite is
   * a specific bottling somebody chose, a brand rule is a broad filter, and the
   * two are revoked independently — the report already hides such a favorite
   * while the brand rule stands, so lifting the rule restores it instead of
   * having silently destroyed it.
   *
   * Statement order is fixed (products, brands, favorites) so two concurrent
   * transactions of the same user acquire their locks in the same sequence.
   *
   * @param userId - Whose blacklist to extend.
   * @param input - Product and brand ids to hide; either may be empty.
   * @returns The user's preferences after the change.
   */
  @Transactional()
  public async addToBlacklist(
    userId: ID,
    input: PreferenceBlacklistIds,
  ): Promise<Preference> {
    const productIds = CorePreferenceService.normalize(input.productIds);
    const brandIds = CorePreferenceService.normalize(input.brandIds);

    await this.repo.addBlacklistProducts(userId, productIds);
    await this.repo.addBlacklistBrands(userId, brandIds);
    await this.repo.removeFavorites(userId, productIds);

    return this.repo.findByUserId(userId);
  }

  /**
   * Un-hides bottlings and/or brands. Entries that were not hidden are ignored,
   * and no favorite is restored — un-hiding is not the inverse of hiding, since
   * hiding a bottling deliberately gave up its favorite.
   *
   * @param userId - Whose blacklist to trim.
   * @param input - Product and brand ids to un-hide; either may be empty.
   * @returns The user's preferences after the change.
   */
  @Transactional()
  public async removeFromBlacklist(
    userId: ID,
    input: PreferenceBlacklistIds,
  ): Promise<Preference> {
    await this.repo.removeBlacklistProducts(
      userId,
      CorePreferenceService.normalize(input.productIds),
    );

    await this.repo.removeBlacklistBrands(
      userId,
      CorePreferenceService.normalize(input.brandIds),
    );

    return this.repo.findByUserId(userId);
  }
}
