import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  FlavorCandidateRow,
  ID,
  MetaCountry,
  PriceHistoryPoint,
  ProductUpsertInput,
  ProductUpsertResult,
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
   * Inserts or updates a product by its `(storeId, sku)` identity, preserving
   * first-insert and manually-edited fields on conflict. In backfill mode the
   * still-null columns of an existing row are filled as well.
   *
   * @param input - The resolved product to write.
   * @param backfill - Whether to fill still-null columns on conflict.
   * @returns The product id and whether it was newly inserted.
   */
  public async upsertFromScrape(
    input: ProductUpsertInput,
    backfill = false,
  ): Promise<ProductUpsertResult> {
    return this.repo.upsertFromScrape(input, backfill);
  }

  /**
   * SKUs of a store's products that already have an ABV (the detail-fetch
   * gate).
   *
   * @param storeId - Store id.
   * @returns The set of SKUs with an ABV.
   */
  public async skusWithAbv(storeId: ID): Promise<Set<string>> {
    return this.repo.skusWithAbv(storeId);
  }

  /**
   * SKUs of a store's products whose ABV, volume, type and country are all
   * filled (the backfill run's wider detail-fetch gate).
   *
   * @param storeId - Store id.
   * @returns The set of SKUs whose detail-page fields are complete.
   */
  public async skusWithCoreDetails(storeId: ID): Promise<Set<string>> {
    return this.repo.skusWithCoreDetails(storeId);
  }

  /**
   * SKUs of a store's products that already exist, in any stock state (the
   * name-extraction gate).
   *
   * @param storeId - Store id.
   * @returns The set of SKUs already stored for the store.
   */
  public async existingSkus(storeId: ID): Promise<Set<string>> {
    return this.repo.existingSkus(storeId);
  }

  /**
   * Flags a store's products as out of stock by SKU; a no-op when the list is
   * empty. The rows and their price history are kept.
   *
   * @param storeId - Store id.
   * @param skus - SKUs to flag.
   * @returns How many products were flagged.
   */
  public async markOutOfStockBySkus(
    storeId: ID,
    skus: string[],
  ): Promise<number> {
    return this.repo.markOutOfStockBySkus(storeId, skus);
  }

  /**
   * Flags every in-stock product of a store as out of stock except the given
   * SKUs (the sweep after a full listing).
   *
   * @param storeId - Store id.
   * @param keepSkus - SKUs seen in stock this run, to leave untouched.
   * @returns How many products were flagged.
   */
  public async markOutOfStockExcept(
    storeId: ID,
    keepSkus: string[],
  ): Promise<number> {
    return this.repo.markOutOfStockExcept(storeId, keepSkus);
  }

  /**
   * Clears the age of the given products.
   *
   * @param ids - Products whose age to clear.
   * @returns How many rows changed.
   */
  public async clearAges(ids: ID[]): Promise<number> {
    return this.repo.clearAges(ids);
  }

  /**
   * Replaces a product's keyword-derived flavor links with the given set. LLM
   * -derived links are left untouched.
   *
   * @param productId - Product id.
   * @param flavorIds - Flavor ids to link.
   * @returns Resolves once the links are replaced.
   */
  public async setFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    return this.repo.setFlavors(productId, flavorIds);
  }

  /**
   * Replaces a product's LLM-derived flavor links with the given set and marks
   * the product as classified, even when the set is empty.
   *
   * @param productId - Product id.
   * @param flavorIds - Flavor ids the model returned.
   * @returns Resolves once the links are replaced.
   */
  public async setLlmFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    return this.repo.setLlmFlavors(productId, flavorIds);
  }

  /**
   * Products the LLM flavor pass has never answered for.
   *
   * @param storeSlug - Restrict to one store's products, or omit for all.
   * @returns One candidate per product still lacking an LLM answer.
   */
  public async findFlavorCandidates(
    storeSlug?: string,
  ): Promise<FlavorCandidateRow[]> {
    return this.repo.findFlavorCandidates(storeSlug);
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
   * Counts the in-stock products of a store.
   *
   * @param storeId - Store id.
   * @returns The in-stock product count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    return this.repo.countByStore(storeId);
  }
}
