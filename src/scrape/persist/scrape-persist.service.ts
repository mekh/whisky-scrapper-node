import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { PERSIST_SWEEP_GUARD_RATIO } from '~constants';
import { CoreBrandService } from '~core/brand';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { ProductMatchUtils, ProductNameUtils } from '~utils';

import type {
  ID,
  ProductCanonicalInput,
  ProductFillInput,
  ProductScrapeFlavorLink,
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreProductUpsertResult,
} from '~types';

import type {
  CanonicalResolution,
  PersistCounts,
  PersistLookups,
  ResolvedSnapshot,
} from './scrape-persist.interfaces';

/**
 * Writes a store's scraped in-stock snapshots and flags its out-of-stock
 * offers in a single transaction.
 *
 * The write has two halves. The catalogue half resolves each snapshot to a
 * bottling by its match key, creating the ones nobody has listed before, and
 * contributes whatever the store knows about fields the bottling is still
 * missing. The store half upserts the offer itself — SKU, page, availability,
 * dates — and today's price. Nothing is ever deleted: availability is the
 * `store_product.inStock` flag, so price history survives out-of-stock periods.
 *
 * **Lock ordering is load-bearing.** The whole persist runs in one transaction
 * that can last minutes, and up to `SYNC_MAX_PARALLEL_TRACKS` stores persist
 * concurrently against the *same* canonical rows. Two of them touching the same
 * two bottlings in opposite orders would deadlock, and losing a deadlock throws
 * away a whole store's scrape. So every canonical row is acquired in ascending
 * match-key order, and every flavor link in ascending `(productId, flavorId)`
 * order. A match key never changes, which is what makes that a total order all
 * transactions agree on.
 */
@Injectable()
export class ScrapePersistService {
  private readonly logger = new Logger(ScrapePersistService.name);

  private readonly brands: CoreBrandService;

  private readonly types: CoreTypeService;

  private readonly flavors: CoreFlavorService;

  private readonly countries: CoreCountryService;

  private readonly products: CoreProductService;

  private readonly storeProducts: CoreStoreProductService;

  private readonly snapshots: CorePriceSnapshotService;

  public constructor(
    brands: CoreBrandService,
    types: CoreTypeService,
    flavors: CoreFlavorService,
    countries: CoreCountryService,
    products: CoreProductService,
    storeProducts: CoreStoreProductService,
    snapshots: CorePriceSnapshotService,
  ) {
    this.brands = brands;
    this.types = types;
    this.flavors = flavors;
    this.countries = countries;
    this.products = products;
    this.storeProducts = storeProducts;
    this.snapshots = snapshots;
  }

  /**
   * Persists a store's collection: resolves every in-stock snapshot to a
   * bottling, upserts the offer and its price, and flags the offers the run did
   * not see in stock — all in one transaction.
   *
   * @param storeId - The store being written.
   * @param inStock - Normalized in-stock snapshots to upsert.
   * @param oosSkus - SKUs the listing explicitly returned as out of stock.
   * @param capturedOn - The capture day (`YYYY-MM-DD`) for the snapshots.
   * @param reporter - Optional progress reporter, told what the transaction
   * wrote and whether the sweep was guarded.
   * @returns How many offers were stored, added and flagged out of stock, and
   * how many bottlings were new to the catalogue.
   */
  @Transactional()
  public async persist(
    storeId: ID,
    inStock: ProductSnapshot[],
    oosSkus: string[],
    capturedOn: string,
    reporter?: ScrapeProgressReporter,
  ): Promise<PersistCounts> {
    const inStockBefore = await this.storeProducts.countByStore(storeId);

    const brandIds = await this.brands.resolveByName(
      this.distinct(inStock.map((snap) => snap.brand)),
    );
    const typeIds = await this.types.resolveByName(
      this.distinct(inStock.map((snap) => snap.whiskyType)),
    );
    const flavorIds = await this.flavors.resolveByName(
      this.distinct([
        ...inStock.flatMap((snap) => snap.flavorTags),
        ...inStock.flatMap((snap) => snap.llmFlavorTags ?? []),
      ]),
    );
    const countryIds = await this.countries.resolveByNameUa(
      this.distinct(inStock.map((snap) => snap.country)),
    );

    const lookups = { brandIds, typeIds, countryIds };
    const known = await this.storeProducts.existingSkus(storeId);
    const work = this.resolveKeys(inStock);
    const canonical = await this.resolveCanonical(work, known, lookups);

    const fills = new Map<ID, ProductFillInput>();
    const links: ProductScrapeFlavorLink[] = [];
    const stamped = new Set<ID>();
    let stored = 0;
    let added = 0;
    let addedProducts = canonical.added;

    for (const { snap, matchKey } of work) {
      const proposed = known.has(snap.storeSku)
        ? null
        : canonical.slots.get(this.canonicalSlot(snap, matchKey)) ?? null;

      const written = await this.upsertOffer(
        storeId,
        snap,
        proposed,
        capturedOn,
        lookups,
      );

      const { offer } = written;
      addedProducts += written.createdProduct ? 1 : 0;

      if (!fills.has(offer.productId)) {
        fills.set(offer.productId, {
          id: offer.productId,
          abv: snap.abv,
          brandId: this.brandId(snap, lookups.brandIds),
          typeId: this.typeId(snap, lookups.typeIds),
          countryId: this.countryId(snap, lookups.countryIds),
        });
      }

      snap.flavorTags.forEach((tag) => {
        const flavorId = flavorIds.get(tag);

        if (flavorId) {
          links.push({ productId: offer.productId, flavorId });
        }
      });

      await this.writeLlmFlavors(offer.productId, snap, flavorIds, stamped);

      await this.snapshots.upsertForDate(offer.id, capturedOn, {
        price: snap.price,
        oldPrice: snap.oldPrice,
        currency: snap.currency,
        inStock: snap.inStock,
        promo: snap.promo,
      });

      stored += 1;

      if (offer.isNew) {
        added += 1;
      }
    }

    await this.products.fillMissing([...fills.values()]);
    await this.products.addScrapeFlavors(this.orderLinks(links));

    const removed = await this.flagOutOfStock(
      storeId,
      inStock.map((snap) => snap.storeSku),
      oosSkus,
      inStockBefore,
      reporter,
    );

    reporter?.({
      kind: 'persisted',
      stored,
      added,
      addedProducts,
      removed,
    });

    return { stored, added, addedProducts, removed };
  }

  /**
   * Pairs every snapshot with the match key of the bottling it describes, and
   * orders the run by that key.
   *
   * The key is normally computed by the collection passes and carried on the
   * snapshot, so the key that decided which enrichment to pay for is the same
   * one the write looks the product up by; it is recomputed here only when a
   * caller supplied none. The ordering is the deadlock guard described on the
   * class.
   *
   * @param inStock - The run's in-stock snapshots.
   * @returns The snapshots with their keys, ordered by key with the unmatchable
   * ones last.
   */
  private resolveKeys(inStock: ProductSnapshot[]): ResolvedSnapshot[] {
    const resolved = inStock.map((snap) => ({
      snap,
      matchKey: snap.matchKey ?? ProductMatchUtils.key(
        ProductNameUtils.resolve(snap.cleanName, snap.name),
        snap.brand,
        snap.volumeMl,
        snap.ageYears,
      ),
    }));

    return resolved.sort((a, b) => {
      if (a.matchKey === b.matchKey) {
        return a.snap.storeSku.localeCompare(b.snap.storeSku);
      }

      if (a.matchKey === null) {
        return 1;
      }

      if (b.matchKey === null) {
        return -1;
      }

      return a.matchKey.localeCompare(b.matchKey);
    });
  }

  /**
   * Resolves the bottlings this run's **new** SKUs belong to, creating the ones
   * the catalogue does not have.
   *
   * Only new SKUs are keyed. A stored offer keeps whatever bottling it is
   * already linked to, which is what makes a manual relink permanent and stops
   * a reworded listing from spawning a second row for a whisky the store has
   * been selling all along.
   *
   * @param work - The run's snapshots with their keys.
   * @param known - SKUs the store already lists.
   * @param lookups - Resolved brand/type/country id maps.
   * @returns The slot-to-id map and how many bottlings were created.
   */
  private async resolveCanonical(
    work: ResolvedSnapshot[],
    known: Set<string>,
    lookups: PersistLookups,
  ): Promise<CanonicalResolution> {
    const fresh = work.filter(({ snap }) => !known.has(snap.storeSku));
    const byKey = new Map<string, ProductCanonicalInput>();
    const unmatchable: ResolvedSnapshot[] = [];

    fresh.forEach((item) => {
      if (item.matchKey === null) {
        unmatchable.push(item);

        return;
      }

      if (!byKey.has(item.matchKey)) {
        byKey.set(item.matchKey, this.canonicalInput(item, lookups));
      }
    });

    const sorted = [...byKey.values()].sort((a, b) =>
      (a.matchKey ?? '').localeCompare(b.matchKey ?? '')
    );

    const { ids, added } = await this.products.findOrCreateByMatchKeys(sorted);
    const slots = new Map<string, ID>(ids);

    for (const item of unmatchable) {
      const id = await this.products.createUnmatched(
        this.canonicalInput(item, lookups),
      );

      slots.set(this.canonicalSlot(item.snap, null), id);
    }

    return { slots, added: added + unmatchable.length };
  }

  /**
   * The map slot a snapshot's bottling is stored under. A keyed snapshot shares
   * its slot with every sibling carrying the same key; an unmatchable one gets
   * a slot of its own, since nothing may be pooled onto it.
   *
   * @param snap - The snapshot.
   * @param matchKey - Its match key, or null.
   * @returns The slot.
   */
  private canonicalSlot(
    snap: ProductSnapshot,
    matchKey: string | null,
  ): string {
    return matchKey ?? ` ${snap.storeSku}`;
  }

  /**
   * Builds the canonical row a snapshot would create.
   *
   * @param item - The snapshot with its key.
   * @param lookups - Resolved brand/type/country id maps.
   * @returns The bottling to insert.
   */
  private canonicalInput(
    item: ResolvedSnapshot,
    lookups: PersistLookups,
  ): ProductCanonicalInput {
    const { snap } = item;

    return {
      matchKey: item.matchKey,
      name: ProductNameUtils.resolve(snap.cleanName, snap.name),
      brandId: this.brandId(snap, lookups.brandIds),
      typeId: this.typeId(snap, lookups.typeIds),
      countryId: this.countryId(snap, lookups.countryIds),
      age: snap.ageYears,
      abv: snap.abv,
      volumeMl: snap.volumeMl,
    };
  }

  /**
   * Writes one store offer, falling back to an insert when a SKU believed to be
   * stored turns out not to be (it can be deleted between the gate query and
   * this write).
   *
   * @param storeId - The store being written.
   * @param snap - The snapshot to write.
   * @param proposed - The bottling to link a new SKU to, or null for a stored
   * one.
   * @param capturedOn - The capture day.
   * @param lookups - Resolved brand/type/country id maps.
   * @returns The written offer, and whether the fallback had to create a
   * bottling for it.
   */
  private async upsertOffer(
    storeId: ID,
    snap: ProductSnapshot,
    proposed: ID | null,
    capturedOn: string,
    lookups: PersistLookups,
  ): Promise<{ offer: StoreProductUpsertResult; createdProduct: boolean }> {
    const input = {
      storeId,
      productId: proposed,
      sku: snap.storeSku,
      url: snap.url,
      nameOrig: snap.name,
      seenOn: capturedOn,
    };

    const offer = await this.storeProducts.upsertFromScrape(input);

    if (offer) {
      return { offer, createdProduct: false };
    }

    const created = await this.products.createUnmatched(
      this.canonicalInput({ snap, matchKey: null }, lookups),
    );

    const inserted = await this.storeProducts.upsertFromScrape({
      ...input,
      productId: created,
    }) as StoreProductUpsertResult;

    return { offer: inserted, createdProduct: true };
  }

  /**
   * Writes the classification pass's answer onto the bottling, when it
   * answered at all. Writing on an unanswered item would stamp
   * `lastLlmFlavorAt` and hide the product from every later pass.
   *
   * Two SKUs of one bottling (two sizes, or a boxed and a plain listing) share
   * a canonical row and carry the same answer, so the write runs once per
   * bottling rather than once per offer.
   *
   * @param productId - The bottling to stamp.
   * @param snap - The snapshot carrying the answer.
   * @param flavorIds - Resolved flavor id map.
   * @param stamped - Bottlings already written this run.
   * @returns Resolves once the links are written.
   */
  private async writeLlmFlavors(
    productId: ID,
    snap: ProductSnapshot,
    flavorIds: Map<string, ID>,
    stamped: Set<ID>,
  ): Promise<void> {
    if (!snap.llmFlavorChecked || stamped.has(productId)) {
      return;
    }

    stamped.add(productId);

    await this.products.setLlmFlavors(
      productId,
      (snap.llmFlavorTags ?? [])
        .map((tag) => flavorIds.get(tag))
        .filter((id): id is ID => id !== undefined),
    );
  }

  /**
   * Deduplicates and orders the run's keyword flavor links, so concurrent
   * stores insert them in the same order.
   *
   * @param links - The links collected during the write loop.
   * @returns The distinct links, ordered.
   */
  private orderLinks(
    links: ProductScrapeFlavorLink[],
  ): ProductScrapeFlavorLink[] {
    const seen = new Map<string, ProductScrapeFlavorLink>();

    links.forEach((link) => {
      seen.set(`${link.productId}:${link.flavorId}`, link);
    });

    return [...seen.values()].sort((a, b) =>
      a.productId.localeCompare(b.productId)
      || a.flavorId.localeCompare(b.flavorId)
    );
  }

  /**
   * Resolves a snapshot's brand to an id.
   *
   * @param snap - The snapshot.
   * @param ids - Resolved brand id map.
   * @returns The brand id, or null.
   */
  private brandId(snap: ProductSnapshot, ids: Map<string, ID>): ID | null {
    return snap.brand ? ids.get(snap.brand) ?? null : null;
  }

  /**
   * Resolves a snapshot's whisky type to an id.
   *
   * @param snap - The snapshot.
   * @param ids - Resolved type id map.
   * @returns The type id, or null.
   */
  private typeId(snap: ProductSnapshot, ids: Map<string, ID>): ID | null {
    return snap.whiskyType ? ids.get(snap.whiskyType) ?? null : null;
  }

  /**
   * Resolves a snapshot's country to an id. Countries are keyed by their
   * lower-cased Ukrainian name, and are never created on the fly.
   *
   * @param snap - The snapshot.
   * @param ids - Resolved country id map.
   * @returns The country id, or null.
   */
  private countryId(snap: ProductSnapshot, ids: Map<string, ID>): ID | null {
    return snap.country
      ? ids.get(snap.country.trim().toLowerCase()) ?? null
      : null;
  }

  /**
   * Flags this run's unavailable offers. Normally a sweep: every offer of the
   * store not seen in stock this run (explicitly out of stock or missing from
   * the listing) is flagged. When the run's in-stock count is suspiciously low
   * against the pre-run baseline — a likely truncated listing — the sweep is
   * skipped and only the explicit out-of-stock SKUs are flagged. A store that
   * legitimately shrank past the guard keeps warning on every run until its
   * stock recovers or the rows are fixed manually; a wrongly flagged offer
   * self-heals on the next run.
   *
   * @param storeId - The store being written.
   * @param inStockSkus - SKUs seen in stock this run.
   * @param oosSkus - SKUs the listing explicitly returned as out of stock.
   * @param baseline - The store's in-stock offer count before this run.
   * @param reporter - Optional progress reporter, told when the sweep was
   * skipped.
   * @returns How many offers were flagged out of stock.
   */
  private async flagOutOfStock(
    storeId: ID,
    inStockSkus: string[],
    oosSkus: string[],
    baseline: number,
    reporter?: ScrapeProgressReporter,
  ): Promise<number> {
    const sweepIsSafe =
      inStockSkus.length >= baseline * PERSIST_SWEEP_GUARD_RATIO;

    if (sweepIsSafe) {
      return this.storeProducts.markOutOfStockExcept(storeId, inStockSkus);
    }

    this.logger.warn(
      'Listing looks truncated (%d in stock vs %d stored); '
        + 'flagging only the explicit out-of-stock SKUs',
      inStockSkus.length,
      baseline,
    );
    reporter?.({
      kind: 'sweep-guarded',
      inStock: inStockSkus.length,
      baseline,
    });

    return this.storeProducts.markOutOfStockBySkus(storeId, oosSkus);
  }

  /**
   * Collects the distinct non-empty values of a nullable string list.
   *
   * @param values - Values to dedupe.
   * @returns The distinct non-empty values.
   */
  private distinct(values: (string | null)[]): string[] {
    return [
      ...new Set(
        values.filter((value): value is string => Boolean(value)),
      ),
    ];
  }
}
