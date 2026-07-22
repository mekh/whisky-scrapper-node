import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { StoreListItem } from '~types';

import { StoreEntity } from './store.entity';

// Store joined with its 1:1 scrape config; ordered by display name.
const STORE_WITH_CONFIG_SQL = `
  SELECT st.id, st.slug, st.name, st."baseUrl", st.color, st.active,
         sc.tier, sc."needsBrowser", sc."retailChain", sc.category
  FROM store st
  LEFT JOIN store_config sc ON sc."storeId" = st.id
`;

@TypeormRepository(StoreEntity)
export class StoreRepository extends BaseRepository<StoreEntity> {
  /**
   * Lists every store with its scrape config, ordered by name.
   *
   * @returns Store + config rows.
   */
  public async findAllWithConfig(): Promise<StoreListItem[]> {
    return this.query(
      `${STORE_WITH_CONFIG_SQL} ORDER BY st.name`,
    ) as Promise<StoreListItem[]>;
  }

  /**
   * Loads a single store with its scrape config by slug.
   *
   * @param slug - Store slug.
   * @returns The store + config row, or null when no store has the slug.
   */
  public async findWithConfigBySlug(
    slug: string,
  ): Promise<StoreListItem | null> {
    const rows = await this.query(
      `${STORE_WITH_CONFIG_SQL} WHERE st.slug = $1`,
      [slug],
    ) as StoreListItem[];

    return rows[0] ?? null;
  }

  /**
   * Toggles a store's active flag by slug.
   *
   * @param slug - Store slug.
   * @param active - New active value.
   * @returns True when a store was updated, false when the slug is unknown.
   */
  public async setActiveBySlug(
    slug: string,
    active: boolean,
  ): Promise<boolean> {
    const result = await this.createQueryBuilder()
      .update()
      .set({ active })
      .where('slug = :slug', { slug })
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
