import { Injectable } from '@nestjs/common';

import { CoreBrandService } from '~core/brand';
import { CorePreferenceService } from '~core/preference';
import { CoreProductService } from '~core/product';
import { CoreUserService } from '~core/user';
import { BadRequestError } from '~errors';
import type {
  ID,
  Preference,
  PreferenceBlacklistInput,
  PreferenceFavoritesInput,
} from '~types';

/**
 * Business layer for a user's favorites and blacklist: resolves brand names to
 * ids, rejects references the catalogue does not carry, and leaves the
 * set arithmetic to {@link CorePreferenceService}.
 */
@Injectable()
export class PreferenceService {
  /**
   * Rejects a blacklist request that names nothing.
   *
   * @param input - The request to check.
   * @throws {BadRequestError} When neither list carries an entry.
   */
  private static assertNotEmpty(input: PreferenceBlacklistInput): void {
    if (!input.productIds?.length && !input.brands?.length) {
      throw new BadRequestError(
        'Blacklist requires at least one product or brand',
      );
    }
  }

  public constructor(
    private readonly preferences: CorePreferenceService,
    private readonly brands: CoreBrandService,
    private readonly products: CoreProductService,
    private readonly users: CoreUserService,
  ) {}

  /**
   * Loads the calling user's own preferences.
   *
   * No existence check: the id comes from a verified access token, so the user
   * is known to exist.
   *
   * @param userId - The authenticated user.
   * @returns Their favorites and blacklist.
   */
  public async getOwn(userId: ID): Promise<Preference> {
    return this.preferences.findByUserId(userId);
  }

  /**
   * Loads another user's preferences, for an admin or for the user themselves.
   *
   * @param userId - Whose preferences to read.
   * @returns Their favorites and blacklist.
   * @throws {NotFoundError} When no such user exists — otherwise a mistyped id
   *   would answer with an empty but entirely plausible payload.
   */
  public async getForUser(userId: ID): Promise<Preference> {
    await this.users.findByIdOrThrow(userId);

    return this.preferences.findByUserId(userId);
  }

  /**
   * Adds bottlings to the user's favorites.
   *
   * @param userId - Whose favorites to extend.
   * @param input - Canonical product ids; an empty list is a no-op.
   * @returns Their preferences after the change.
   * @throws {BadRequestError} When an id matches no bottling.
   */
  public async addFavorites(
    userId: ID,
    input: PreferenceFavoritesInput,
  ): Promise<Preference> {
    await this.assertProductsExist(input.productIds);

    return this.preferences.addFavorites(userId, input.productIds);
  }

  /**
   * Removes bottlings from the user's favorites.
   *
   * Unknown ids are not rejected here: a delete that matches nothing changes
   * nothing, so the extra round trip would buy only a different status code.
   *
   * @param userId - Whose favorites to trim.
   * @param input - Canonical product ids; an empty list is a no-op.
   * @returns Their preferences after the change.
   */
  public async removeFavorites(
    userId: ID,
    input: PreferenceFavoritesInput,
  ): Promise<Preference> {
    return this.preferences.removeFavorites(userId, input.productIds);
  }

  /**
   * Hides bottlings and/or brands from every report for this user. Hiding a
   * bottling also drops it from their favorites; see
   * {@link CorePreferenceService.addToBlacklist}.
   *
   * @param userId - Whose blacklist to extend.
   * @param input - Product ids and/or brand names; at least one is required.
   * @returns Their preferences after the change.
   * @throws {BadRequestError} When both lists are empty, an id matches no
   *   bottling, or a name matches no brand.
   */
  public async addToBlacklist(
    userId: ID,
    input: PreferenceBlacklistInput,
  ): Promise<Preference> {
    const productIds = input.productIds ?? [];

    PreferenceService.assertNotEmpty(input);
    await this.assertProductsExist(productIds);

    const brandIds = await this.resolveBrandIds(input.brands ?? []);

    return this.preferences.addToBlacklist(userId, { productIds, brandIds });
  }

  /**
   * Un-hides bottlings and/or brands.
   *
   * Brand names are still resolved strictly, and that is safe rather than
   * pedantic: `blacklist_brand` cascades from `brand`, so an entry can never
   * outlive the brand it names — a name nothing matches is a name the user
   * never hid.
   *
   * @param userId - Whose blacklist to trim.
   * @param input - Product ids and/or brand names; at least one is required.
   * @returns Their preferences after the change.
   * @throws {BadRequestError} When both lists are empty or a name matches no
   *   brand.
   */
  public async removeFromBlacklist(
    userId: ID,
    input: PreferenceBlacklistInput,
  ): Promise<Preference> {
    PreferenceService.assertNotEmpty(input);

    const brandIds = await this.resolveBrandIds(input.brands ?? []);

    return this.preferences.removeFromBlacklist(userId, {
      productIds: input.productIds ?? [],
      brandIds,
    });
  }

  /**
   * Resolves brand names to ids, creating nothing.
   *
   * @param names - Canonical brand names as `/report` reports them.
   * @returns The matching brand ids.
   * @throws {BadRequestError} When a name matches no brand in the catalogue.
   */
  private async resolveBrandIds(names: string[]): Promise<ID[]> {
    if (!names.length) {
      return [];
    }

    const resolved = await this.brands.findIdsByName(names);

    const unknown = names.filter((name) => !resolved.has(name.trim()));

    if (unknown.length) {
      throw new BadRequestError('Unknown brand', { brands: unknown });
    }

    return [...resolved.values()];
  }

  /**
   * Rejects product ids the catalogue does not carry, so a write cannot fail on
   * a foreign key the client would read as a server error.
   *
   * @param ids - Canonical product ids to check.
   * @throws {BadRequestError} When an id matches no bottling.
   */
  private async assertProductsExist(ids: ID[]): Promise<void> {
    if (!ids.length) {
      return;
    }

    const existing = await this.products.findExistingIds(ids);

    const unknown = ids.filter((id) => !existing.has(id));

    if (unknown.length) {
      throw new BadRequestError('Unknown product', { products: unknown });
    }
  }
}
