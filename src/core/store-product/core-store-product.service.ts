import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  ID,
  MetaCountry,
  ReportCurrentRow,
  ReportFilter,
  StoreProductRef,
  StoreProductUpsertInput,
  StoreProductUpsertResult,
} from '~types';

import { StoreProductEntity } from './store-product.entity';
import { StoreProductRepository } from './store-product.repository';

/**
 * Persistence-layer public API for the `store_product` entity — one store's
 * offer of a bottling. Uniqueness is the composite `(storeId, sku)` enforced at
 * the database level.
 *
 * It also owns the report's read queries, because one row of those results is
 * one store's offer: the id, availability and store filter are all this
 * entity's, and the bottling's fields ride along.
 */
@Injectable()
export class CoreStoreProductService extends CoreBaseService<
  StoreProductEntity
> {
  public constructor(protected readonly repo: StoreProductRepository) {
    super(repo);
  }

  /**
   * Inserts or refreshes one store's offer by its `(storeId, sku)` identity. A
   * null `productId` means the SKU is already stored and its link to a bottling
   * must be left untouched.
   *
   * @param input - The offer to write.
   * @returns The offer id, its bottling and whether it was newly inserted, or
   *   null when a refresh matched no row.
   */
  public async upsertFromScrape(
    input: StoreProductUpsertInput,
  ): Promise<StoreProductUpsertResult | null> {
    return this.repo.upsertFromScrape(input);
  }

  /**
   * SKUs a store already lists, whatever their stock state.
   *
   * @param storeId - Store id.
   * @returns The set of stored SKUs.
   */
  public async existingSkus(storeId: ID): Promise<Set<string>> {
    return this.repo.existingSkus(storeId);
  }

  /**
   * Flags the given SKUs of a store out of stock; rows are kept.
   *
   * @param storeId - Store id.
   * @param skus - SKUs to flag.
   * @returns How many offers were flagged.
   */
  public async markOutOfStockBySkus(
    storeId: ID,
    skus: string[],
  ): Promise<number> {
    return this.repo.markOutOfStockBySkus(storeId, skus);
  }

  /**
   * Flags every in-stock offer of a store except the given SKUs; rows are kept.
   *
   * @param storeId - Store id.
   * @param keepSkus - SKUs seen in stock this run.
   * @returns How many offers were flagged.
   */
  public async markOutOfStockExcept(
    storeId: ID,
    keepSkus: string[],
  ): Promise<number> {
    return this.repo.markOutOfStockExcept(storeId, keepSkus);
  }

  /**
   * Loads the current state of every in-stock offer matching the filter.
   *
   * @param filter - The report filter.
   * @returns One row per matching offer.
   */
  public async findCurrentRows(
    filter: ReportFilter,
  ): Promise<ReportCurrentRow[]> {
    return this.repo.findCurrentRows(filter);
  }

  /**
   * Loads one offer's current row by id, out-of-stock ones included.
   *
   * @param id - Store-offer id.
   * @returns The current row, or null when the offer has no snapshot.
   */
  public async findCurrentRowById(id: ID): Promise<ReportCurrentRow | null> {
    return this.repo.findCurrentRowById(id);
  }

  /**
   * Resolves an offer id or a canonical product id to one concrete offer.
   *
   * @param id - A store-offer id or a canonical product id.
   * @returns The resolved offer, or null when the id matches neither.
   */
  public async findOfferRefById(id: ID): Promise<StoreProductRef | null> {
    return this.repo.findOfferRefById(id);
  }

  /**
   * Lists the countries referenced by at least one in-stock offer.
   *
   * @returns Countries present in the catalog, ordered by Ukrainian name.
   */
  public async distinctCountries(): Promise<MetaCountry[]> {
    return this.repo.distinctCountries();
  }

  /**
   * Counts a store's in-stock offers.
   *
   * @param storeId - Store id.
   * @returns The in-stock offer count.
   */
  public async countByStore(storeId: ID): Promise<number> {
    return this.repo.countByStore(storeId);
  }

  /**
   * Resolves an offer id from a search term: an id of either kind, or a
   * name/URL substring.
   *
   * @param term - The search term.
   * @returns The matching offer id, or null when nothing matches.
   */
  public async resolveIdByTerm(term: string): Promise<ID | null> {
    return this.repo.resolveIdByTerm(term);
  }
}
