import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { ABV_TOLERANCE, PERSIST_SWEEP_GUARD_RATIO } from '~constants';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { FactSource, ProductFactField } from '~enums';
import { ProductMatchUtils, ProductNameUtils } from '~utils';

import { KbApplyService } from '../kb/kb-apply.service';

import type {
  ID,
  ListingResult,
  ProductCanonicalInput,
  ProductFactConflictInput,
  ProductFillInput,
  ProductScrapeFlavorLink,
  ProductSnapshot,
  ProductStoredFactsRow,
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
 * **The sweep is gated on the listing walk, not on a count.** Flagging every
 * unseen offer out of stock is only sound if the run actually reached the end
 * of the store's listing; see {@link flagOutOfStock} for what that buys and
 * what the count heuristic it replaced got wrong.
 *
 * **The day's snapshots are then reconciled with the sweep's verdict.** A
 * snapshot is written when an offer is *seen* in stock, while availability is
 * decided only once the whole listing has been walked — and a capture day can
 * hold several runs. So the write ends by flagging every row of the store's day
 * whose offer the sweep left out of stock. Without it the day's first run owned
 * its rows and no later one could correct them (an out-of-stock offer is never
 * upserted), which made a day read as the high-water mark of its availability
 * rather than its close.
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

  private readonly types: CoreTypeService;

  private readonly flavors: CoreFlavorService;

  private readonly countries: CoreCountryService;

  private readonly products: CoreProductService;

  private readonly storeProducts: CoreStoreProductService;

  private readonly snapshots: CorePriceSnapshotService;

  private readonly producers: CoreProducerService;

  private readonly kb: KbApplyService;

  public constructor(
    types: CoreTypeService,
    flavors: CoreFlavorService,
    countries: CoreCountryService,
    products: CoreProductService,
    storeProducts: CoreStoreProductService,
    snapshots: CorePriceSnapshotService,
    producers: CoreProducerService,
    kb: KbApplyService,
  ) {
    this.types = types;
    this.flavors = flavors;
    this.countries = countries;
    this.products = products;
    this.storeProducts = storeProducts;
    this.snapshots = snapshots;
    this.producers = producers;
    this.kb = kb;
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
   * @param listing - How the run's listing walk ended. Only a walk that
   * reached the end of the source's listing earns the sweep.
   * @param reporter - Optional progress reporter, told what the transaction
   * wrote and whether the sweep ran.
   * @returns How many offers were stored, added and flagged out of stock, and
   * how many bottlings were new to the catalogue.
   */
  @Transactional()
  public async persist(
    storeId: ID,
    inStock: ProductSnapshot[],
    oosSkus: string[],
    capturedOn: string,
    listing: ListingResult,
    reporter?: ScrapeProgressReporter,
  ): Promise<PersistCounts> {
    const inStockBefore = await this.storeProducts.countByStore(storeId);

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

    const lookups = { typeIds, countryIds };
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
          typeId: this.typeId(snap, lookups.typeIds),
          countryId: this.countryId(snap, lookups.countryIds),
          brandOrig: snap.brand,
          abvSource: this.factSource(snap, ProductFactField.ABV),
          typeSource: this.factSource(snap, ProductFactField.TYPE),
          countrySource: this.factSource(snap, ProductFactField.COUNTRY),
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

    await this.logConflicts(storeId, [...fills.values()]);
    await this.products.fillMissing([...fills.values()]);
    await this.products.addScrapeFlavors(this.orderLinks(links));
    await this.applyKb([...fills.keys()], reporter);

    const removed = await this.flagOutOfStock(
      storeId,
      inStock.map((snap) => snap.storeSku),
      oosSkus,
      inStockBefore,
      listing,
      reporter,
    );

    await this.snapshots.markOutOfStockForDay(storeId, capturedOn);

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
   * @param lookups - Resolved type/country id maps.
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
    return matchKey ?? `\0${snap.storeSku}`;
  }

  /**
   * Builds the canonical row a snapshot would create.
   *
   * @param item - The snapshot with its key.
   * @param lookups - Resolved type/country id maps.
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
      brandOrig: snap.brand,
      typeId: this.typeId(snap, lookups.typeIds),
      countryId: this.countryId(snap, lookups.countryIds),
      age: snap.ageYears,
      abv: snap.abv,
      volumeMl: snap.volumeMl,
      factSources: snap.factSources,
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
   * @param lookups - Resolved type/country id maps.
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
   * Applies the knowledge base to the bottlings this run touched.
   *
   * Position in `persist` is the whole design. It runs **after**
   * `writeLlmFlavors`, which happens inside the upsert loop, so it can strip a
   * peat tag the model just wrote — before this hook existed, every sync
   * quietly re-created the errors the reconciliation pass had corrected, and
   * the catalogue only stayed right until the next cron. It runs after
   * `addScrapeFlavors` for the same reason.
   *
   * It is scoped to the run's own bottlings rather than the catalogue: a sync
   * is not the place to rewrite four thousand rows, and anything it misses is
   * `pnpm reconcile-flavors`'s job.
   *
   * Unresolved bottlings are not a failure and are not queued anywhere. The
   * queue is derivable at any time — a brand key with no alias match — so a
   * table for it would be a second copy of a fact the aliases already state.
   * A count goes to the log instead.
   *
   * Best-effort: a knowledge-base failure must not lose a scrape that
   * succeeded.
   *
   * @param productIds - The bottlings this run wrote.
   * @param reporter - Optional progress reporter.
   * @returns Resolves once the writes are done, or immediately on failure.
   */
  private async applyKb(
    productIds: ID[],
    reporter?: ScrapeProgressReporter,
  ): Promise<void> {
    if (!productIds.length) {
      return;
    }

    try {
      const index = await this.producers.loadIndex();

      if (!index.aliases.length) {
        return;
      }

      const rows = await this.products.findKbReconcileCandidates(
        undefined,
        undefined,
        productIds,
      );

      const typeIds = await this.producers.resolveTypeIds(
        [
          ...new Set(
            index.aliases
              .map((alias) => alias.producer.defaultTypeName)
              .filter((name): name is string => Boolean(name)),
          ),
        ],
      );

      const plan = this.kb.plan(rows, index, typeIds);

      await this.products.setProducers(plan.producers);
      await this.products.applyKbFacts(plan.facts);

      await this.products.applyKbFlavors(
        plan.flavors.filter((write) =>
          write.insertFlavorIds.length || write.deleteFlavorIds.length
        ),
      );

      const unresolved = plan.resolutions
        .filter((one) => !one.producer).length;

      if (unresolved) {
        this.logger.warn(
          '%d of %d name groups resolved to no producer',
          unresolved,
          plan.groups.length,
        );
      }

      reporter?.({
        kind: 'kb-applied',
        groups: plan.groups.length,
        unresolved,
      });
    } catch (error) {
      this.logger.warn('Knowledge base pass failed: %o', error);
    }
  }

  /**
   * Records the store claims that contradict what the catalogue already holds.
   *
   * It runs immediately **before** `fillMissing`, and that position is the
   * whole design. `fillMissing` is where a claim is silently discarded — the
   * rank-aware write keeps the better-sourced value and says nothing about the
   * one it dropped — and `rawAttrs` is never persisted, so this is the last
   * moment at which the live claim and the stored value exist together. A
   * later script could not reconstruct either.
   *
   * `age` and `volumeMl` are never compared. Both are components of the frozen
   * match key, so a store stating a different one is describing a *different
   * bottling*; comparing them produced ~376 structural false positives that
   * buried every real finding.
   *
   * The whole thing is best-effort: a sync must not fail because a QA log
   * could not be written.
   *
   * @param storeId - The store being synced.
   * @param fills - The claims this run is about to write, one per bottling.
   * @returns Resolves once the log is written, or immediately on failure.
   */
  private async logConflicts(
    storeId: ID,
    fills: ProductFillInput[],
  ): Promise<void> {
    if (!fills.length) {
      return;
    }

    try {
      const stored = await this.products.findFactsByIds(
        fills.map((fill) => fill.id),
      );

      const byId = new Map(stored.map((row) => [row.id, row]));
      const conflicts: ProductFactConflictInput[] = [];

      fills.forEach((fill) => {
        const row = byId.get(fill.id);

        if (row) {
          conflicts.push(...this.compareFacts(storeId, fill, row));
        }
      });

      /**
       * Lock order. Two stores syncing concurrently touch overlapping
       * bottlings, and the upsert takes a row lock per key; ascending
       * `(productId, storeId, attribute)` is the order both agree on.
       */
      conflicts.sort((left, right) =>
        left.productId.localeCompare(right.productId)
        || left.storeId.localeCompare(right.storeId)
        || left.attribute.localeCompare(right.attribute)
      );

      await this.products.logFactConflicts(conflicts);
    } catch (error) {
      this.logger.debug('Fact conflict logging failed: %o', error);
    }
  }

  /**
   * Compares one store's claim against the stored facts.
   *
   * A claim only counts as a contradiction when both sides state something:
   * a store that says nothing has not disagreed, and a stored null is a gap
   * that `fillMissing` is about to close rather than a conflict.
   *
   * @param storeId - The store making the claim.
   * @param fill - The claim.
   * @param row - The stored facts and their provenance.
   * @returns One entry per contradicted attribute.
   */
  private compareFacts(
    storeId: ID,
    fill: ProductFillInput,
    row: ProductStoredFactsRow,
  ): ProductFactConflictInput[] {
    const out: ProductFactConflictInput[] = [];

    const add = (
      attribute: ProductFactField,
      storedValue: string,
      claimedValue: string,
      storedSource: FactSource | null,
    ): void => {
      out.push({
        productId: fill.id,
        storeId,
        attribute,
        storedValue,
        claimedValue,
        storedSource: storedSource ?? FactSource.LEGACY,
      });
    };

    if (fill.typeId && row.typeId && fill.typeId !== row.typeId) {
      add(ProductFactField.TYPE, row.typeId, fill.typeId, row.typeSource);
    }

    if (fill.countryId && row.countryId && fill.countryId !== row.countryId) {
      add(
        ProductFactField.COUNTRY,
        row.countryId,
        fill.countryId,
        row.countrySource,
      );
    }

    /**
     * ABV is compared with a tolerance because the same bottling is genuinely
     * listed at 40 % by one shop and 43 % by another — `Balvenie DoubleWood`
     * is the standing example — while a 0.05 rounding difference is noise.
     */
    if (
      fill.abv !== null && fill.abv !== undefined
      && row.abv !== null
      && Math.abs(Number(fill.abv) - Number(row.abv)) > ABV_TOLERANCE
    ) {
      add(
        ProductFactField.ABV,
        String(row.abv),
        String(fill.abv),
        row.abvSource,
      );
    }

    return out;
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
   * Where a snapshot's fact came from.
   *
   * Falls back to `store` rather than to `legacy`: everything reaching persist
   * has been through normalization, which stamps every fact it sees, so an
   * unstamped one can only be a value written after that pass — and the only
   * writer there is the store's own detail data.
   *
   * @param snap - The snapshot.
   * @param field - The fact field.
   * @returns The recorded source, or `store`.
   */
  private factSource(
    snap: ProductSnapshot,
    field: ProductFactField,
  ): FactSource {
    return snap.factSources[field] ?? FactSource.STORE;
  }

  /**
   * Flags this run's unavailable offers.
   *
   * Normally a sweep: every offer of the store not seen in stock this run —
   * explicitly out of stock or missing from the listing — is flagged. What
   * gates it is the listing walk's own verdict: a walk that reached the end of
   * the source's listing proves that an offer it did not see is genuinely
   * gone, while a walk that gave up on a failed page holds a fragment and
   * proves nothing, so only the explicit out-of-stock SKUs are flagged.
   *
   * This used to be gated on a count ratio instead, and that could not tell a
   * store whose stock really collapsed from a scrape that broke. It got both
   * cases wrong in opposite directions. A store that legitimately shrank past
   * the ratio was frozen: the baseline is the *live* in-stock count, which
   * skipping the sweep is precisely what stops from falling, so every later
   * run compared against the same stale number and skipped again — silpo went
   * from 1070 offers to 249 on 2026-08-22 and would have served 578 sold-out
   * bottles indefinitely. And a listing that broke after collecting 60 % of
   * itself sailed past the ratio and flagged the other 40 % as unavailable.
   *
   * The ratio survives as an alert, not a veto, because the two failure modes
   * are not symmetric: an offer wrongly flagged out of stock comes back on the
   * next run, while one wrongly left in stock stays until someone notices.
   *
   * @param storeId - The store being written.
   * @param inStockSkus - SKUs seen in stock this run.
   * @param oosSkus - SKUs the listing explicitly returned as out of stock.
   * @param baseline - The store's in-stock offer count before this run.
   * @param listing - How the run's listing walk ended.
   * @param reporter - Optional progress reporter, told whether the sweep ran.
   * @returns How many offers were flagged out of stock.
   */
  private async flagOutOfStock(
    storeId: ID,
    inStockSkus: string[],
    oosSkus: string[],
    baseline: number,
    listing: ListingResult,
    reporter?: ScrapeProgressReporter,
  ): Promise<number> {
    if (!listing.complete) {
      this.logger.warn(
        'Listing incomplete (%s): flagging only the explicit '
          + 'out-of-stock SKUs',
        listing.stop,
      );
      reporter?.({
        kind: 'listing-incomplete',
        stop: listing.stop,
        inStock: inStockSkus.length,
        baseline,
      });

      return this.storeProducts.markOutOfStockBySkus(storeId, oosSkus);
    }

    if (inStockSkus.length < baseline * PERSIST_SWEEP_GUARD_RATIO) {
      this.logger.warn(
        'Stock dropped sharply (%d in stock vs %d stored) on a listing that '
          + 'reached its end; sweeping anyway',
        inStockSkus.length,
        baseline,
      );
      reporter?.({
        kind: 'stock-drop',
        inStock: inStockSkus.length,
        baseline,
      });
    }

    return this.storeProducts.markOutOfStockExcept(storeId, inStockSkus);
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
