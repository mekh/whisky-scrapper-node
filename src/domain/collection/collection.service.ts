import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { CoreCurrencyService } from '~core/currency';
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreStoreProductService } from '~core/store-product';
import {
  CoreUserCollectionPurchaseService,
  CoreUserCollectionService,
} from '~core/user-collection';
import { BadRequestError, NotFoundError } from '~errors';
import type {
  CollectionCreateInput,
  CollectionIds,
  CollectionItem,
  CollectionOffer,
  CollectionPurchase,
  CollectionPurchaseInput,
  CollectionPurchaseRate,
  CollectionPurchaseResolved,
  CollectionPurchaseRow,
  CollectionPurchaseUpdateInput,
  CollectionPurchasesPatchInput,
  CollectionRow,
  CollectionRowResolved,
  CollectionUpdateInput,
  ID,
  ReportCurrentRow,
} from '~types';
import { OfferPriceUtils } from '~utils';

/**
 * The two mutually exclusive shop fields a purchase (or a patch to one) may
 * carry — the shape {@link CollectionService.assertSingleStoreField} checks,
 * shared by a brand-new purchase and an update to an existing one.
 */
interface StoreFields {
  storeSlug?: string;

  storeName?: string;
}

/**
 * Business layer for a user's personal whisky collection: composes the
 * collection row, its purchases and its current catalogue offers into one
 * {@link CollectionItem}, and resolves the cross-entity references a client
 * request carries (a store slug, a catalogue offer) before the core layer
 * ever sees them.
 */
@Injectable()
export class CollectionService {
  public constructor(
    private readonly collection: CoreUserCollectionService,
    private readonly purchases: CoreUserCollectionPurchaseService,
    private readonly offers: CoreStoreProductService,
    private readonly products: CoreProductService,
    private readonly stores: CoreStoreService,
    private readonly currencies: CoreCurrencyService,
  ) {}

  /**
   * Lists the caller's whole collection, each item composed with its
   * purchases and current offers.
   *
   * Purchases and offers are each loaded in one bulk call, by every row's id
   * at once, and then grouped in memory — never one query per row, which
   * would turn a collection of a few hundred bottlings into a few hundred
   * round trips.
   *
   * @param userId - The authenticated user.
   * @returns Every collection row, composed; empty when they hold nothing.
   */
  public async getOwn(userId: ID): Promise<CollectionItem[]> {
    const rows = await this.collection.findByUserId(userId);

    if (!rows.length) {
      return [];
    }

    const [purchasesByRow, offersByProduct] = await Promise.all([
      this.loadPurchases(rows.map((row) => row.id)),
      this.loadOffers(rows.map((row) => row.productId)),
    ]);

    return rows.map((row) =>
      this.toItem(
        row,
        purchasesByRow.get(row.id) ?? [],
        offersByProduct.get(row.productId) ?? [],
      )
    );
  }

  /**
   * The cheap membership read a catalogue listing joins against to mark
   * "already in my collection", mirroring `GET /preference`.
   *
   * @param userId - The authenticated user.
   * @returns The bottling ids the user already holds.
   */
  public async getOwnIds(userId: ID): Promise<CollectionIds> {
    const productIds = await this.collection.findProductIdsByUserId(userId);

    return { productIds };
  }

  /**
   * Adds a bottling to the caller's collection, optionally with its first
   * purchase.
   *
   * Validation runs in a fixed order, each failure a {@link BadRequestError}:
   * the bottling must exist; a named catalogue offer must exist and belong to
   * that same bottling; the purchase must not name both a known store and a
   * free-text one; and a named store slug must resolve to a real store. The
   * whole write — the row and its first purchase — is one transaction, so a
   * failed purchase insert never leaves a bare collection row behind.
   *
   * See {@link resolvePurchase} for why the offer-derived price and store are
   * filled in here rather than trusted from the client.
   *
   * @param userId - The authenticated user.
   * @param input - The bottling to add, its personal fields, and an optional
   *   first purchase.
   * @returns The newly composed collection item.
   * @throws {BadRequestError} On any of the validation failures above.
   * @throws {DuplicateError} When the bottling is already in the collection.
   */
  @Transactional()
  public async create(
    userId: ID,
    input: CollectionCreateInput,
  ): Promise<CollectionItem> {
    await this.assertProductExists(input.productId);

    const purchase = input.purchase
      ? await this.resolvePurchase(input.purchase, input.productId)
      : null;

    const id = await this.collection.createForUser(
      userId,
      input.productId,
      this.toCreateRow(input),
    );

    if (purchase) {
      await this.purchases.createForCollection(id, purchase);
    }

    return this.itemOrThrow(userId, id);
  }

  /**
   * Edits a collection row — its own fields and any changes to its
   * purchases — as one transaction, so the edit screen's single «save»
   * either lands whole or not at all.
   *
   * Ownership is settled once, up front, by loading the row rather than
   * relying on the row update's affected count: a purchase-only request
   * carries an empty row patch, which the repository skips, and would
   * otherwise reach the purchase writes without ever proving the row is the
   * caller's. The loaded row is needed anyway — its bottling is what an
   * added purchase's catalogue offer must belong to.
   *
   * @param userId - The authenticated user.
   * @param id - The row to update.
   * @param input - The fields to change and the purchase changes; an absent
   *   field is left alone.
   * @returns The freshly composed item.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   user, or a patched or removed purchase is not this row's.
   * @throws {BadRequestError} Per {@link applyPurchasesPatch}.
   */
  @Transactional()
  public async update(
    userId: ID,
    id: ID,
    input: CollectionUpdateInput,
  ): Promise<CollectionItem> {
    const row = await this.rowOrThrow(userId, id);

    await this.collection.updateForUser(
      userId,
      row.id,
      this.toUpdateRow(input),
    );

    if (input.purchases) {
      await this.applyPurchasesPatch(row, input.purchases);
    }

    return this.itemOrThrow(userId, row.id);
  }

  /**
   * Removes a whisky from the caller's collection, its purchases cascading
   * with it.
   *
   * @param userId - The authenticated user.
   * @param id - The row to remove.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   user.
   */
  public async remove(userId: ID, id: ID): Promise<void> {
    await this.collection.deleteForUser(userId, id);
  }

  /**
   * Applies every purchase change of an update request to one collection
   * row: deletions first, then patches, then additions.
   *
   * The order is what keeps the three groups independent of each other. A
   * deleted purchase cannot also be patched — the same id in both lists is
   * rejected outright rather than resolved by whichever ran last — and an
   * added purchase has no id yet, so it can collide with neither. An id
   * listed twice among the deletions is deleted once, since the second
   * attempt would otherwise answer "not found" for a purchase the request
   * did mean to remove. Every write is scoped to the row, so a purchase id
   * belonging to another row is a `NotFoundError` from the core layer,
   * never a write. The collection row itself survives an emptied list — a
   * whisky with no bottles left is still a legitimate entry (tasted at a
   * bar, or a gift).
   *
   * @param row - The owning collection row, already proven the caller's.
   * @param patch - The purchase changes.
   * @throws {BadRequestError} When a purchase is both patched and removed,
   *   or an entry fails {@link resolvePurchase} / {@link toPurchaseUpdateRow}.
   * @throws {NotFoundError} When a patched or removed purchase is not this
   *   row's.
   */
  private async applyPurchasesPatch(
    row: CollectionRow,
    patch: CollectionPurchasesPatchInput,
  ): Promise<void> {
    this.assertDisjointPurchaseChanges(patch);

    for (const purchaseId of new Set(patch.remove ?? [])) {
      await this.purchases.deleteForCollection(row.id, purchaseId);
    }

    for (const change of patch.update ?? []) {
      const values = await this.toPurchaseUpdateRow(change);

      await this.purchases.updateForCollection(row.id, change.id, values);
    }

    for (const input of patch.add ?? []) {
      const resolved = await this.resolvePurchase(input, row.productId);

      await this.purchases.createForCollection(row.id, resolved);
    }
  }

  /**
   * Rejects a purchases patch that names the same purchase among both the
   * patches and the deletions: the two are contradictory, and applying one
   * of them silently would make the outcome depend on the order the service
   * happens to write in.
   *
   * @param patch - The purchase changes to check.
   * @throws {BadRequestError} When an id appears in both lists.
   */
  private assertDisjointPurchaseChanges(
    patch: CollectionPurchasesPatchInput,
  ): void {
    const removed = new Set(patch.remove ?? []);

    const clash = (patch.update ?? []).find((change) => removed.has(change.id));

    if (clash) {
      throw new BadRequestError(
        'A purchase cannot be both patched and removed in one request',
        { purchaseId: clash.id },
      );
    }
  }

  /**
   * Loads the current in-stock offers of a set of bottlings in one call and
   * groups them by bottling, cheapest first.
   *
   * @param productIds - Canonical bottling ids to load offers for.
   * @returns Bottling id to its offers; a bottling absent from every store
   *   is simply not a key.
   */
  private async loadOffers(
    productIds: ID[],
  ): Promise<Map<ID, CollectionOffer[]>> {
    if (!productIds.length) {
      return new Map();
    }

    const rows = await this.offers.findCurrentRowsByProductIds(productIds);
    const grouped = new Map<ID, ReportCurrentRow[]>();

    rows.forEach((row) => {
      const bucket = grouped.get(row.productId) ?? [];

      bucket.push(row);
      grouped.set(row.productId, bucket);
    });

    const result = new Map<ID, CollectionOffer[]>();

    grouped.forEach((group, productId) => {
      const ordered = [...group].sort(
        (a, b) => OfferPriceUtils.byPrice(a, b),
      );

      result.set(productId, ordered.map((row) => this.toOffer(row)));
    });

    return result;
  }

  /**
   * Loads every purchase of a set of collection rows in one call and groups
   * them by row, oldest first.
   *
   * @param collectionIds - Collection rows to load purchases for.
   * @returns Collection row id to its purchases; a row with none recorded is
   *   simply not a key.
   */
  private async loadPurchases(
    collectionIds: ID[],
  ): Promise<Map<ID, CollectionPurchase[]>> {
    if (!collectionIds.length) {
      return new Map();
    }

    const rows = await this.purchases.findByCollectionIds(collectionIds);
    const ratesByDay = await this.loadRates(rows);
    const grouped = new Map<ID, CollectionPurchaseRow[]>();

    rows.forEach((row) => {
      const bucket = grouped.get(row.collectionId) ?? [];

      bucket.push(row);
      grouped.set(row.collectionId, bucket);
    });

    const result = new Map<ID, CollectionPurchase[]>();

    grouped.forEach((group, collectionId) => {
      const ordered = [...group].sort(
        (a, b) => this.comparePurchaseDate(a, b),
      );

      result.set(
        collectionId,
        ordered.map((row) =>
          this.toPurchase(row, ratesByDay.get(row.purchasedOn) ?? [])
        ),
      );
    });

    return result;
  }

  /**
   * Resolves the official rate of every non-base display currency on every
   * day the given purchases were made.
   *
   * Keyed by day rather than by purchase: the rate is a property of the date,
   * so a collection where twenty bottles were bought on one afternoon costs
   * one lookup for that afternoon. All of it is one statement — the batching
   * primitive `CurrencyConversionService.convertMany` is built on — because a
   * per-purchase probe would make a hundred-bottle shelf a hundred queries.
   *
   * @param rows - The purchase rows about to be projected.
   * @returns Purchase day to one entry per non-base currency, ordered by
   *   code; an empty map when there are no purchases or no such currency.
   */
  private async loadRates(
    rows: CollectionPurchaseRow[],
  ): Promise<Map<string, CollectionPurchaseRate[]>> {
    if (!rows.length) {
      return new Map();
    }

    const active = await this.currencies.findActive();
    const codes = active
      .filter((currency) => !currency.isBase)
      .map((currency) => currency.code)
      .sort();

    if (!codes.length) {
      return new Map();
    }

    const days = [...new Set(rows.map((row) => row.purchasedOn))];
    const probes = await this.currencies.probeRates(
      days.flatMap((day) => codes.map((code) => ({ code, day }))),
    );

    const byKey = new Map(
      probes.map((probe) => [`${probe.code}|${probe.requestedOn}`, probe]),
    );

    return new Map(
      days.map((day) => [
        day,
        codes.map((code) => {
          const probe = byKey.get(`${code}|${day}`);

          return {
            code,
            rate: probe?.rate ?? null,
            effectiveOn: probe?.effectiveOn ?? null,
          };
        }),
      ]),
    );
  }

  /**
   * Composes one collection row with its already-loaded purchases and
   * offers.
   *
   * @param row - The collection row's own fields plus the bottling's facts.
   * @param purchases - That row's purchases, oldest first.
   * @param offers - That bottling's current offers, cheapest first.
   * @returns The composed item.
   */
  private toItem(
    row: CollectionRow,
    purchases: CollectionPurchase[],
    offers: CollectionOffer[],
  ): CollectionItem {
    return { ...row, purchases, offers };
  }

  /**
   * Projects a report-current row onto the narrower offer shape a collection
   * item shows: what re-buying this bottling would cost today.
   *
   * @param row - The current row of one store's offer.
   * @returns The collection offer view of it.
   */
  private toOffer(row: ReportCurrentRow): CollectionOffer {
    const referencePrice = OfferPriceUtils.previousDrop(row);

    return {
      id: row.id,
      url: row.url,
      storeSlug: row.storeSlug,
      storeName: row.storeName,
      price: row.price,
      oldPrice: row.oldPrice,
      referencePrice,
      discountPct: OfferPriceUtils.discountPct(row.price, referencePrice),
      currency: row.currency,
      promo: row.promo,
      capturedDate: row.capturedDate,
    };
  }

  /**
   * Projects a purchase row onto its public shape, nesting the flattened
   * store columns back into one object.
   *
   * @param row - The purchase row, store columns flattened.
   * @param rates - The rates in force on this purchase's day, already
   *   resolved by {@link CollectionService.loadRates}.
   * @returns The purchase, store nested and rates attached.
   */
  private toPurchase(
    row: CollectionPurchaseRow,
    rates: CollectionPurchaseRate[],
  ): CollectionPurchase {
    return {
      id: row.id,
      purchasedOn: row.purchasedOn,
      price: row.price,
      store: row.storeSlug && row.storeLabel
        ? { slug: row.storeSlug, name: row.storeLabel, color: row.storeColor }
        : null,
      storeName: row.storeName,
      storeProductId: row.storeProductId,
      createdAt: row.createdAt,
      rates,
    };
  }

  /**
   * Resolves a purchase request into the shape the core layer writes:
   * `storeSlug` settled to a real store id, and — when the purchase names a
   * catalogue offer — the price and store defaulted from it.
   *
   * That defaulting happens here, server-side, rather than trusting a value
   * the client read off the catalogue: `/report/*` is cached for up to ten
   * minutes, so a price a client captured "at the moment I clicked buy" could
   * already be stale by the time this request lands, and persisting it would
   * quietly record a number the shop had already moved past. Reading the
   * offer again in this same request is the freshest either side can do.
   *
   * @param input - The purchase as the client sent it.
   * @param expectedProductId - The bottling a named offer must belong to,
   *   when the caller knows it: the row being created, or the existing row
   *   a bottle is being added to.
   * @returns The purchase with its store reference resolved.
   * @throws {BadRequestError} When a named offer or store does not exist, the
   *   offer belongs to a different bottling, or both store fields are set.
   */
  private async resolvePurchase(
    input: CollectionPurchaseInput,
    expectedProductId?: ID,
  ): Promise<CollectionPurchaseResolved> {
    const offer = input.storeProductId
      ? await this.loadPurchaseOffer(input.storeProductId, expectedProductId)
      : null;

    this.assertSingleStoreField(input);

    const namesNoStore = !input.storeSlug && !input.storeName;
    const storeSlug = input.storeSlug
      ?? (namesNoStore ? offer?.storeSlug : undefined);

    return {
      purchasedOn: input.purchasedOn,
      price: input.price ?? offer?.price,
      storeId: storeSlug ? await this.resolveStoreId(storeSlug) : undefined,
      storeName: input.storeName,
      storeProductId: input.storeProductId,
    };
  }

  /**
   * Loads a collection row composed with its purchases and offers, for a
   * caller that has just mutated it and must answer the fresh result.
   *
   * @param userId - The claimed owner.
   * @param id - The collection row to reload.
   * @returns The composed item.
   * @throws {NotFoundError} When the pair matches no row.
   */
  private async itemOrThrow(userId: ID, id: ID): Promise<CollectionItem> {
    const row = await this.rowOrThrow(userId, id);

    const [purchasesByRow, offersByProduct] = await Promise.all([
      this.loadPurchases([row.id]),
      this.loadOffers([row.productId]),
    ]);

    return this.toItem(
      row,
      purchasesByRow.get(row.id) ?? [],
      offersByProduct.get(row.productId) ?? [],
    );
  }

  /**
   * Loads one collection row by its id and claimed owner — the ownership
   * check every write goes through, spelled as a read so a foreign id is a
   * `404` and never a `403` that would confirm the row exists.
   *
   * @param userId - The claimed owner.
   * @param id - The collection row to load.
   * @returns The row with its bottling's facts.
   * @throws {NotFoundError} When the pair matches no row.
   */
  private async rowOrThrow(userId: ID, id: ID): Promise<CollectionRow> {
    const row = await this.collection.findByIdForUser(id, userId);

    if (!row) {
      throw new NotFoundError('Collection item not found', { id });
    }

    return row;
  }

  /**
   * Rejects a bottling id the catalogue does not carry, so a write cannot
   * fail on a foreign key the client would read as a server error.
   *
   * @param productId - The bottling id to check.
   * @throws {BadRequestError} When it matches no bottling.
   */
  private async assertProductExists(productId: ID): Promise<void> {
    const existing = await this.products.findExistingIds([productId]);

    if (!existing.has(productId)) {
      throw new BadRequestError('Unknown product', { productId });
    }
  }

  /**
   * Loads the catalogue offer a purchase names, rejecting an unknown id or
   * one belonging to a different bottling than expected.
   *
   * @param storeProductId - The offer id the purchase named.
   * @param expectedProductId - The bottling it must belong to, when known.
   * @returns The offer's current row.
   * @throws {BadRequestError} When the id is unknown, or it names an offer of
   *   a different bottling.
   */
  private async loadPurchaseOffer(
    storeProductId: ID,
    expectedProductId?: ID,
  ): Promise<ReportCurrentRow> {
    const offer = await this.offers.findCurrentRowById(storeProductId);

    if (!offer) {
      throw new BadRequestError('Unknown store offer', { storeProductId });
    }

    if (expectedProductId && offer.productId !== expectedProductId) {
      throw new BadRequestError(
        'Store offer belongs to a different product',
        { storeProductId, productId: offer.productId },
      );
    }

    return offer;
  }

  /**
   * Resolves a store slug to its id.
   *
   * @param slug - The slug to resolve.
   * @returns The store's id.
   * @throws {BadRequestError} When no store carries that slug.
   */
  private async resolveStoreId(slug: string): Promise<ID> {
    const store = await this.stores.findOne({ slug });

    if (!store) {
      throw new BadRequestError('Unknown store', { storeSlug: slug });
    }

    return store.id;
  }

  /**
   * Rejects a purchase (or a patch to one) naming both a known store and a
   * free-text one — the two are mutually exclusive by the database's own
   * CHECK constraint, and this is what turns that into a 400 instead of a
   * raw constraint violation.
   *
   * @param input - The store fields to check.
   * @throws {BadRequestError} When both are set.
   */
  private assertSingleStoreField(input: StoreFields): void {
    if (input.storeSlug && input.storeName) {
      throw new BadRequestError(
        'A purchase cannot name both a known store and a free-text shop',
      );
    }
  }

  /**
   * Maps a create request's own fields onto the row the core layer writes.
   * Nothing here needs the empty-string-clears convention {@link toUpdateRow}
   * uses — there is no prior value to clear on a brand-new row.
   *
   * @param input - The create request.
   * @returns The row's initial values.
   */
  private toCreateRow(input: CollectionCreateInput): CollectionRowResolved {
    return {
      rating: input.rating,
      barcode: input.barcode,
      notes: input.notes,
      nose: input.nose,
      palate: input.palate,
      finish: input.finish,
    };
  }

  /**
   * Maps an update request onto the row patch the core layer writes: a
   * present text field maps to its value, or to `null` when it is the empty
   * string (how a client clears a note or the barcode); `clearRating` maps
   * `rating` to `null`; a field absent from the request is omitted from the
   * patch entirely rather than written as `undefined`.
   *
   * @param input - The fields to change.
   * @returns Only the columns that should change.
   */
  private toUpdateRow(input: CollectionUpdateInput): CollectionRowResolved {
    const values: CollectionRowResolved = {};

    if (input.clearRating) {
      values.rating = null;
    } else if (input.rating !== undefined) {
      values.rating = input.rating;
    }

    if (input.barcode !== undefined) {
      values.barcode = input.barcode === '' ? null : input.barcode;
    }

    if (input.notes !== undefined) {
      values.notes = input.notes === '' ? null : input.notes;
    }

    if (input.nose !== undefined) {
      values.nose = input.nose === '' ? null : input.nose;
    }

    if (input.palate !== undefined) {
      values.palate = input.palate === '' ? null : input.palate;
    }

    if (input.finish !== undefined) {
      values.finish = input.finish === '' ? null : input.finish;
    }

    return values;
  }

  /**
   * Maps a purchase patch onto the row patch the core layer writes.
   * `clearStore` wins over a named store field, and naming `storeSlug`
   * resolves it to an id and clears any stored free-text name (and
   * symmetrically for `storeName`), so the pair can never end up both set.
   *
   * @param input - The fields to change.
   * @returns Only the columns that should change.
   * @throws {BadRequestError} When the patch names both store fields, or an
   *   unknown store slug.
   */
  private async toPurchaseUpdateRow(
    input: CollectionPurchaseUpdateInput,
  ): Promise<CollectionPurchaseResolved> {
    this.assertSingleStoreField(input);

    const values: CollectionPurchaseResolved = {};

    if (input.purchasedOn !== undefined) {
      values.purchasedOn = input.purchasedOn;
    }

    if (input.clearPrice) {
      values.price = null;
    } else if (input.price !== undefined) {
      values.price = input.price;
    }

    if (input.clearStore) {
      values.storeId = null;
      values.storeName = null;
    } else if (input.storeSlug !== undefined) {
      values.storeId = await this.resolveStoreId(input.storeSlug);
      values.storeName = null;
    } else if (input.storeName !== undefined) {
      values.storeName = input.storeName;
      values.storeId = null;
    }

    return values;
  }

  /**
   * Orders two purchases oldest-first, ties broken by insertion order.
   *
   * @param a - First purchase row.
   * @param b - Second purchase row.
   * @returns Negative, zero, or positive per standard comparator semantics.
   */
  private comparePurchaseDate(
    a: CollectionPurchaseRow,
    b: CollectionPurchaseRow,
  ): number {
    return a.purchasedOn.localeCompare(b.purchasedOn)
      || a.createdAt.getTime() - b.createdAt.getTime();
  }
}
