import { CollectionTimelineGranularity } from '~enums';

import { ID } from './entity.interfaces';

/**
 * One store's current offer of a bottling, as the collection returns it.
 *
 * A deliberately narrower shape than the report's offer: a collection row is a
 * record of something already bought, so the offers beside it answer "what
 * would it cost today" and nothing else. `referencePrice`/`discountPct` are
 * kept because a shop's running discount is exactly what makes re-buying
 * interesting; the report's recency flags (`isNew`, `daysNew`) are not.
 */
export interface CollectionOffer {
  /**
   * The store offer's id (`store_product.id`).
   */
  id: ID;

  /**
   * Absolute URL of the store's product page.
   */
  url: string;

  /**
   * Slug of the store carrying the offer.
   */
  storeSlug: string;

  /**
   * Display name of that store.
   */
  storeName: string;

  /**
   * Current price in the offer's currency.
   */
  price: number;

  /**
   * The store's own strike-through price, when it advertises one.
   */
  oldPrice: number | null;

  /**
   * The price the discount is measured against — the offer's previous
   * observed price, from our own history, never the shop's `oldPrice`.
   */
  referencePrice: number | null;

  /**
   * Whole-percent drop against {@link referencePrice}, or null when the price
   * has not fallen.
   */
  discountPct: number | null;

  /**
   * ISO currency code of {@link price}.
   */
  currency: string;

  /**
   * Whether the store flags the listing as a promotion.
   */
  promo: boolean;

  /**
   * Day the price was captured (`YYYY-MM-DD`).
   */
  capturedDate: string;
}

/**
 * A known shop resolved for display beside a purchase.
 */
export interface CollectionPurchaseStore {
  /**
   * The store's slug, as `/meta` spells it.
   */
  slug: string;

  /**
   * The store's display name.
   */
  name: string;

  /**
   * The store's brand colour, when configured; the client falls back to a
   * hue derived from the slug.
   */
  color: string | null;
}

/**
 * One bottle bought: when, for how much, and where.
 *
 * A collection item may hold several of these (the same whisky bought twice)
 * or none at all (tasted at a bar, or a gift).
 */
export interface CollectionPurchase {
  /**
   * The purchase row's own id, used to edit or delete it.
   */
  id: ID;

  /**
   * The day the bottle was bought (`YYYY-MM-DD`). User-entered and often far
   * in the past, so it is never derived from `createdAt`.
   */
  purchasedOn: string;

  /**
   * What was paid, in UAH. Null when the user did not record a price.
   */
  price: number | null;

  /**
   * The shop, when it is one of ours.
   */
  store: CollectionPurchaseStore | null;

  /**
   * The shop's name as free text, when it is not one of ours (a duty free, a
   * bar, "подарунок"). Mutually exclusive with {@link store}.
   */
  storeName: string | null;

  /**
   * The catalogue offer this purchase was added from, when it was added
   * straight from a listing. Nulled if that offer is ever deleted.
   */
  storeProductId: ID | null;

  /**
   * When the row was created.
   */
  createdAt: Date;
}

/**
 * One whisky in a user's collection: the bottling's facts, the personal ones,
 * every purchase of it, and what it costs today.
 */
export interface CollectionItem {
  /**
   * The collection row's own id.
   */
  id: ID;

  /**
   * The bottling this row is about. Unique within one user's collection.
   */
  productId: ID;

  /**
   * Personal score, 0..10 with one decimal, or null when not rated yet.
   */
  rating: number | null;

  /**
   * The bottle's barcode as the user entered it, digits only.
   */
  barcode: string | null;

  /**
   * Free-form note about the bottle — where it came from, the occasion.
   */
  notes: string | null;

  /**
   * Structured tasting note: the nose.
   */
  nose: string | null;

  /**
   * Structured tasting note: the palate.
   */
  palate: string | null;

  /**
   * Structured tasting note: the finish.
   */
  finish: string | null;

  /**
   * When the whisky was added to the collection.
   */
  createdAt: Date;

  /**
   * When any of the row's own fields last changed.
   */
  updatedAt: Date;

  /**
   * Cleaned display name of the bottling, or null when cleaning left nothing
   * usable — the client then falls back to {@link nameOrig}.
   */
  name: string | null;

  /**
   * A shop's raw name for the bottling, kept as the display fallback. Null
   * when no store has ever listed it.
   */
  nameOrig: string | null;

  /**
   * Age statement in years, when known.
   */
  age: number | null;

  /**
   * Alcohol by volume in percent, when known.
   */
  abv: number | null;

  /**
   * Bottle volume in millilitres, when known.
   */
  volumeMl: number | null;

  /**
   * The knowledge base's label for the maker — the distillery, or the
   * independent bottler when there is no distillery.
   */
  brand: string | null;

  /**
   * The resolved distillery's name, when one resolved.
   */
  distillery: string | null;

  /**
   * The independent bottler's name; non-null means an independent bottling.
   */
  bottler: string | null;

  /**
   * Whisky type name, when resolved.
   */
  type: string | null;

  /**
   * ISO country code of origin, when resolved.
   */
  countryCode: string | null;

  /**
   * Ukrainian country name, when resolved.
   */
  countryName: string | null;

  /**
   * Country flag emoji, when resolved.
   */
  countryIcon: string | null;

  /**
   * Scotland region by the market convention, from the resolved distillery.
   * Null for everything that is not a Scotch with a known distillery.
   */
  region: string | null;

  /**
   * Flavour tags of the bottling.
   */
  flavors: string[];

  /**
   * Every purchase of this whisky, oldest first. May be empty.
   */
  purchases: CollectionPurchase[];

  /**
   * The bottling's current in-stock offers, cheapest first. **May be
   * empty** — unlike a report group, a collection row survives the whisky
   * leaving every shop's shelf.
   */
  offers: CollectionOffer[];
}

/**
 * The cheap membership read the catalogues join against, mirroring
 * `GET /preference`: ids only, so a listing can mark what is already owned
 * without the report payload growing a per-row flag.
 */
export interface CollectionIds {
  /**
   * Ids of every bottling in the caller's collection.
   */
  productIds: ID[];
}

/**
 * A purchase as a client sends it. The two store fields are mutually
 * exclusive; naming neither leaves the purchase without a shop, which is
 * legitimate (a gift).
 */
export interface CollectionPurchaseInput {
  /**
   * The day of purchase (`YYYY-MM-DD`). Defaults to today when omitted.
   */
  purchasedOn?: string;

  /**
   * What was paid, in UAH.
   */
  price?: number;

  /**
   * Slug of one of our shops.
   */
  storeSlug?: string;

  /**
   * A shop of the user's own, as free text.
   */
  storeName?: string;

  /**
   * The catalogue offer this was bought from. When it is given and neither a
   * price nor a shop is, the server fills both from that offer's current row.
   */
  storeProductId?: ID;
}

/**
 * The fields of a patch to one purchase. An absent field is left alone; the
 * `clear*` flags are how a value is deliberately removed, since an absent key
 * and an explicit null are not distinguishable once the payload has been
 * through the pipe. Addressed to a purchase by {@link
 * CollectionPurchaseChangeInput}.
 */
export interface CollectionPurchaseUpdateInput {
  /**
   * A new purchase date (`YYYY-MM-DD`).
   */
  purchasedOn?: string;

  /**
   * A new price, in UAH.
   */
  price?: number;

  /**
   * Removes the recorded price.
   */
  clearPrice?: boolean;

  /**
   * Moves the purchase to one of our shops, clearing any free-text name.
   */
  storeSlug?: string;

  /**
   * Moves the purchase to a shop of the user's own, clearing any known store.
   */
  storeName?: string;

  /**
   * Removes the shop entirely, whichever kind it was.
   */
  clearStore?: boolean;
}

/**
 * A patch to one existing purchase, addressed by its id — one entry of
 * {@link CollectionPurchasesPatchInput.update}.
 */
export interface CollectionPurchaseChangeInput
  extends CollectionPurchaseUpdateInput {
  /**
   * The purchase to patch. Scoped to the collection row being updated: an id
   * from another row, even the same user's, matches nothing.
   */
  id: ID;
}

/**
 * Every change to a collection row's purchases, carried by the same request
 * as the row's own fields so that one save on the client is one write here —
 * the three groups apply in one transaction, removals first, then patches,
 * then additions, and a purchase named in both `update` and `remove` is
 * rejected rather than resolved by order.
 */
export interface CollectionPurchasesPatchInput {
  /**
   * Bottles to record, each per {@link CollectionPurchaseInput}'s rules.
   */
  add?: CollectionPurchaseInput[];

  /**
   * Existing purchases to patch, each addressed by its id.
   */
  update?: CollectionPurchaseChangeInput[];

  /**
   * Ids of the purchases to delete. The collection row itself survives an
   * emptied list — a whisky with no bottles left is still a legitimate entry.
   */
  remove?: ID[];
}

/**
 * Request shape for adding a whisky to the collection.
 */
export interface CollectionCreateInput {
  /**
   * The bottling to add.
   */
  productId: ID;

  /**
   * Personal score, 0..10 with one decimal.
   */
  rating?: number;

  /**
   * The bottle's barcode, digits only.
   */
  barcode?: string;

  /**
   * Free-form note.
   */
  notes?: string;

  /**
   * Structured tasting note: the nose.
   */
  nose?: string;

  /**
   * Structured tasting note: the palate.
   */
  palate?: string;

  /**
   * Structured tasting note: the finish.
   */
  finish?: string;

  /**
   * The first purchase, when the whisky is being added because it was bought.
   * Omitted for a whisky that was only tasted.
   */
  purchase?: CollectionPurchaseInput;
}

/**
 * Request shape for editing a collection row: its own fields, and any changes
 * to its purchases, in one request.
 *
 * The text fields clear by being sent empty — an empty tasting note is a real
 * edit, not an absent one. `rating` has no such spelling, so it clears through
 * an explicit flag, the `PATCH /producer/:id` convention. Every key is
 * optional, `purchases` included, so a request may change only purchases,
 * only the row, or both.
 */
export interface CollectionUpdateInput {
  /**
   * A new score, 0..10 with one decimal.
   */
  rating?: number;

  /**
   * Removes the score.
   */
  clearRating?: boolean;

  /**
   * A new barcode; an empty string removes it.
   */
  barcode?: string;

  /**
   * A new note; an empty string removes it.
   */
  notes?: string;

  /**
   * A new nose note; an empty string removes it.
   */
  nose?: string;

  /**
   * A new palate note; an empty string removes it.
   */
  palate?: string;

  /**
   * A new finish note; an empty string removes it.
   */
  finish?: string;

  /**
   * Changes to the row's purchases, applied in the same transaction as the
   * fields above.
   */
  purchases?: CollectionPurchasesPatchInput;
}

/**
 * A purchase with its cross-entity references already resolved to ids — what
 * the core layer writes. The domain layer owns slug resolution so the core
 * never has to reach across entities to validate a write.
 */
export interface CollectionPurchaseResolved {
  /**
   * The day of purchase (`YYYY-MM-DD`); defaulted by the caller.
   */
  purchasedOn?: string;

  /**
   * What was paid, in UAH.
   */
  price?: number | null;

  /**
   * The resolved known store, when the purchase names one.
   */
  storeId?: ID | null;

  /**
   * The free-text shop name, when the purchase names one instead.
   */
  storeName?: string | null;

  /**
   * The catalogue offer the purchase came from.
   */
  storeProductId?: ID | null;
}

/**
 * A collection row's own writable columns, resolved for the core layer. Every
 * value is either a replacement or an explicit null (the "clear" case), so the
 * repository writes exactly the keys it is given.
 */
export interface CollectionRowResolved {
  /**
   * The score, or null to clear it.
   */
  rating?: number | null;

  /**
   * The barcode, or null to clear it.
   */
  barcode?: string | null;

  /**
   * The general note, or null to clear it.
   */
  notes?: string | null;

  /**
   * The nose note, or null to clear it.
   */
  nose?: string | null;

  /**
   * The palate note, or null to clear it.
   */
  palate?: string | null;

  /**
   * The finish note, or null to clear it.
   */
  finish?: string | null;
}

/**
 * One collection row as its SQL projection returns it — the row's own columns
 * plus the bottling's facts, with the purchase store flattened into three
 * nullable columns the domain layer nests.
 */
export interface CollectionRow {
  /**
   * The collection row's id.
   */
  id: ID;

  /**
   * The bottling.
   */
  productId: ID;

  /**
   * Personal score, 0..10.
   */
  rating: number | null;

  /**
   * The bottle's barcode.
   */
  barcode: string | null;

  /**
   * Free-form note.
   */
  notes: string | null;

  /**
   * Structured tasting note: the nose.
   */
  nose: string | null;

  /**
   * Structured tasting note: the palate.
   */
  palate: string | null;

  /**
   * Structured tasting note: the finish.
   */
  finish: string | null;

  /**
   * When the whisky was added.
   */
  createdAt: Date;

  /**
   * When the row last changed.
   */
  updatedAt: Date;

  /**
   * Cleaned bottling name.
   */
  name: string | null;

  /**
   * A shop's raw name for the bottling, the display fallback.
   */
  nameOrig: string | null;

  /**
   * Age statement in years.
   */
  age: number | null;

  /**
   * Alcohol by volume in percent.
   */
  abv: number | null;

  /**
   * Bottle volume in millilitres.
   */
  volumeMl: number | null;

  /**
   * The knowledge base's maker label.
   */
  brand: string | null;

  /**
   * The resolved distillery.
   */
  distillery: string | null;

  /**
   * The independent bottler.
   */
  bottler: string | null;

  /**
   * Whisky type name.
   */
  type: string | null;

  /**
   * ISO country code.
   */
  countryCode: string | null;

  /**
   * Ukrainian country name.
   */
  countryName: string | null;

  /**
   * Country flag emoji.
   */
  countryIcon: string | null;

  /**
   * Scotland region of the resolved distillery.
   */
  region: string | null;

  /**
   * Flavour tags of the bottling.
   */
  flavors: string[];
}

/**
 * One purchase row as its SQL projection returns it, with the store flattened.
 */
export interface CollectionPurchaseRow {
  /**
   * The purchase row's id.
   */
  id: ID;

  /**
   * The collection row it belongs to.
   */
  collectionId: ID;

  /**
   * The day of purchase (`YYYY-MM-DD`).
   */
  purchasedOn: string;

  /**
   * What was paid, in UAH.
   */
  price: number | null;

  /**
   * Slug of the known store, when the purchase names one.
   */
  storeSlug: string | null;

  /**
   * Display name of that store.
   */
  storeLabel: string | null;

  /**
   * Brand colour of that store.
   */
  storeColor: string | null;

  /**
   * The free-text shop name, when the purchase names one instead.
   */
  storeName: string | null;

  /**
   * The catalogue offer the purchase came from.
   */
  storeProductId: ID | null;

  /**
   * When the row was created.
   */
  createdAt: Date;
}

/**
 * The most (or least) expensive bottle a collection holds, named well enough
 * to render without a second read.
 */
export interface CollectionStatsPurchase {
  /**
   * The purchase row.
   */
  purchaseId: ID;

  /**
   * The collection row it belongs to.
   */
  collectionId: ID;

  /**
   * The bottling.
   */
  productId: ID;

  /**
   * Cleaned bottling name.
   */
  name: string | null;

  /**
   * A shop's raw name for the bottling, the display fallback.
   */
  nameOrig: string | null;

  /**
   * Age statement in years.
   */
  age: number | null;

  /**
   * Alcohol by volume in percent.
   */
  abv: number | null;

  /**
   * Bottle volume in millilitres.
   */
  volumeMl: number | null;

  /**
   * What was paid, in UAH.
   */
  price: number;

  /**
   * The day of purchase (`YYYY-MM-DD`).
   */
  purchasedOn: string;

  /**
   * The known shop, when the purchase names one.
   */
  store: CollectionPurchaseStore | null;

  /**
   * The free-text shop name, when the purchase names one instead.
   */
  storeName: string | null;
}

/**
 * Bottles and distinct whiskies grouped by country of origin.
 */
export interface CollectionCountryBucket {
  /**
   * ISO country code, or `unknown` for bottlings whose origin never resolved.
   */
  countryCode: string;

  /**
   * Ukrainian country name; null for the `unknown` bucket.
   */
  countryName: string | null;

  /**
   * Country flag emoji; null for the `unknown` bucket.
   */
  countryIcon: string | null;

  /**
   * How many bottles were bought from that country.
   */
  bottles: number;

  /**
   * How many distinct whiskies of that country the collection holds.
   */
  items: number;
}

/**
 * Bottles and distinct whiskies grouped by Scotland region.
 *
 * Scotch only: a bottling whose country is not Scotland is absent entirely,
 * while a Scotch whose distillery never resolved lands in `unknown`.
 */
export interface CollectionRegionBucket {
  /**
   * The region by the market convention, or `unknown`.
   */
  region: string;

  /**
   * How many bottles came from that region.
   */
  bottles: number;

  /**
   * How many distinct whiskies of that region the collection holds.
   */
  items: number;
}

/**
 * Bottles and spend grouped by where they were bought. Known shops and the
 * user's own free-text ones share the list; only the former carry a slug.
 */
export interface CollectionStoreBucket {
  /**
   * The known store's slug, or null for a free-text shop.
   */
  slug: string | null;

  /**
   * The shop's name, whichever kind it is.
   */
  name: string;

  /**
   * The known store's brand colour, when configured.
   */
  color: string | null;

  /**
   * How many bottles were bought there.
   */
  bottles: number;

  /**
   * Total spend there, over the purchases that carry a price.
   */
  spent: number;
}

/**
 * One bucket of the "bottles added over time" series.
 */
export interface CollectionTimelineBucket {
  /**
   * The bucket's period: `YYYY-MM` for months, `YYYY` for years.
   */
  period: string;

  /**
   * Bottles bought in that period.
   */
  bottles: number;

  /**
   * Spend in that period, over the purchases that carry a price.
   */
  spent: number;
}

/**
 * The timeline, its resolved range echoed back.
 */
export interface CollectionTimeline {
  /**
   * Bucket width the series was built at.
   */
  granularity: CollectionTimelineGranularity;

  /**
   * First month of the resolved range (`YYYY-MM`).
   */
  from: string;

  /**
   * Last month of the resolved range (`YYYY-MM`).
   */
  to: string;

  /**
   * Every bucket in the range, **dense**: a period with no purchases is
   * present with zeros, so a client renders gaps without reconstructing them.
   */
  buckets: CollectionTimelineBucket[];
}

/**
 * The months a collection's purchases actually span.
 */
export interface CollectionStatsBounds {
  /**
   * Month of the earliest purchase (`YYYY-MM`).
   */
  firstMonth: string;

  /**
   * Month of the latest purchase (`YYYY-MM`).
   */
  lastMonth: string;
}

/**
 * Everything the statistics screen shows.
 *
 * The requested range narrows {@link timeline} only: the KPIs and the
 * breakdowns describe the whole collection, which is what "my collection" is
 * asked about, and a range-scoped total would silently disagree with the list
 * the user is looking at.
 */
export interface CollectionStats {
  /**
   * Distinct whiskies in the collection.
   */
  items: number;

  /**
   * Bottles bought, across every whisky.
   */
  bottles: number;

  /**
   * Bottles whose purchase carries a price — the divisor behind
   * {@link avgPrice}, stated so a client can say "of 42 bottles, 38 priced".
   */
  pricedBottles: number;

  /**
   * Total spend, over the purchases that carry a price.
   */
  totalSpent: number;

  /**
   * Mean price paid per priced bottle, or null when none carry a price.
   */
  avgPrice: number | null;

  /**
   * The dearest purchase, or null when nothing carries a price.
   */
  mostExpensive: CollectionStatsPurchase | null;

  /**
   * The cheapest purchase, or null when nothing carries a price.
   */
  cheapest: CollectionStatsPurchase | null;

  /**
   * Countries of origin, most bottles first.
   */
  byCountry: CollectionCountryBucket[];

  /**
   * Scotland regions, most bottles first.
   */
  byRegion: CollectionRegionBucket[];

  /**
   * Shops, most bottles first.
   */
  byStore: CollectionStoreBucket[];

  /**
   * Bottles added over time, within the requested range.
   */
  timeline: CollectionTimeline;

  /**
   * The months the collection's purchases span, or null when it holds none —
   * what a client builds its range picker from.
   */
  bounds: CollectionStatsBounds | null;
}

/**
 * Query shape for the statistics endpoint.
 */
export interface CollectionStatsQuery {
  /**
   * First month of the timeline (`YYYY-MM`); defaults to the collection's own
   * first purchase month.
   */
  from?: string;

  /**
   * Last month of the timeline (`YYYY-MM`); defaults to the current month.
   */
  to?: string;

  /**
   * Bucket width; defaults to months.
   */
  granularity?: CollectionTimelineGranularity;
}

/**
 * One row of KPIs over a user's whole collection, as the repository's
 * summary aggregate projects it — the raw values {@link CollectionStats}'s
 * own summary fields are built from.
 */
export interface CollectionSummaryRow {
  /**
   * Distinct whiskies in the collection, counted over every collection row
   * the user holds — including one with no purchase recorded yet.
   */
  items: number;

  /**
   * Bottles bought, across every whisky.
   */
  bottles: number;

  /**
   * Bottles whose purchase carries a price — the divisor behind
   * {@link avgPrice}, stated so a client can say "of 42 bottles, 38 priced".
   */
  pricedBottles: number;

  /**
   * Total spend, over the purchases that carry a price.
   */
  totalSpent: number;

  /**
   * Mean price paid per priced bottle, or null when none carry a price.
   */
  avgPrice: number | null;
}
