import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  ID,
  MetaCountry,
  PriceHistoryPoint,
  ReportCurrentRow,
  ReportFilter,
} from '~types';

import { ProductEntity } from './product.entity';
import { ProductRepository } from './product.repository';

/**
 * Persistence-layer public API for the `product` entity. Uniqueness is the
 * composite `(storeId, sku)` enforced at the database level. Also exposes the
 * read-side report queries (current state, window extremes, price history).
 */
@Injectable()
export class CoreProductService extends CoreBaseService<ProductEntity> {
  public constructor(protected readonly repo: ProductRepository) {
    super(repo);
  }

  /**
   * Current state of every product matching the filter (latest snapshot +
   * previous price + joins).
   *
   * @param filter - The report filter.
   * @returns One current row per matching product.
   */
  public async findCurrentRows(
    filter: ReportFilter,
  ): Promise<ReportCurrentRow[]> {
    return this.repo.findCurrentRows(filter);
  }

  /**
   * Current row for a single product by id.
   *
   * @param id - Product id.
   * @returns The current row, or null when the product has no snapshot.
   */
  public async findCurrentRowById(id: ID): Promise<ReportCurrentRow | null> {
    return this.repo.findCurrentRowById(id);
  }

  /**
   * The most recent snapshot capture date across all products.
   *
   * @returns The latest date (`YYYY-MM-DD`), or null when there are none.
   */
  public async latestDate(): Promise<string | null> {
    return this.repo.latestDate();
  }

  /**
   * Min/max price per product over snapshots on/after a cutoff date.
   *
   * @param cutoff - Inclusive lower bound date (`YYYY-MM-DD`).
   * @returns Map from product id to its window `{ min, max }` price.
   */
  public async priceExtremes(
    cutoff: string,
  ): Promise<Map<ID, { min: number; max: number }>> {
    return this.repo.priceExtremes(cutoff);
  }

  /**
   * For every product, the date since which its price has not been higher than
   * its current price (when the current price level took hold). Backs the
   * `drops` report's discount-age column.
   *
   * @returns Map from product id to that date (`YYYY-MM-DD`).
   */
  public async currentPriceSince(): Promise<Map<ID, string>> {
    return this.repo.currentPriceSince();
  }

  /**
   * A product's chronological price history (oldest first).
   *
   * @param id - Product id.
   * @param limit - Maximum number of most-recent points to return.
   * @returns Chronological price points.
   */
  public async priceSeries(
    id: ID,
    limit: number,
  ): Promise<PriceHistoryPoint[]> {
    return this.repo.priceSeries(id, limit);
  }

  /**
   * Resolves a product id from a search term (id or name/URL substring).
   *
   * @param term - A product id or a name/URL substring.
   * @returns The matching product id, or null when nothing matches.
   */
  public async resolveIdByTerm(term: string): Promise<ID | null> {
    return this.repo.resolveIdByTerm(term);
  }

  /**
   * Distinct countries referenced by at least one product.
   *
   * @returns Countries present in the catalog, ordered by Ukrainian name.
   */
  public async distinctCountries(): Promise<MetaCountry[]> {
    return this.repo.distinctCountries();
  }

  /**
   * Counts the products currently tracked for a store.
   *
   * @param storeId - Store id.
   * @returns The product count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    return this.repo.countByStore(storeId);
  }
}
