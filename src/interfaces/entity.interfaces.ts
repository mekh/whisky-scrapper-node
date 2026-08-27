import { DeepPartial, FindOptionsWhere } from 'typeorm';

import { Action, Resource } from '~enums';

export type ID = string; // guid v7

export interface EntityBase {
  id: ID;
}

export interface EntityBaseRich extends EntityBase {
  createdAt: Date;
  updatedAt: Date;
}

export type EntityCreateInputBase<
  T extends EntityBaseRich,
> = DeepPartial<
  Omit<
    T,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
  >
>;

export type EntityUpdateInputBase<
  T extends EntityBaseRich,
> = Partial<EntityCreateInputBase<T>>;

export type EntityFindInput<
  T extends EntityBaseRich,
> = FindOptionsWhere<T> | FindOptionsWhere<T>[];

export interface EntityCreateManyResult {
  success: boolean;
  identifiers: ID[];
  errors?: string[];
}

export interface EntityUser extends EntityBaseRich {
  name?: string;
  email?: string;
  password: string;
  admin: boolean;
  active: boolean;
  lastActiveAt?: Date;
}

export interface EntityAuthUser extends
  Pick<
    EntityUser,
    | 'id'
    | 'active'
    | 'admin'
    | 'password'
  > {
  permissions: EntityPermission[];
}

export interface EntityPermission extends EntityBaseRich {
  userId: ID;
  resource: Resource;
  action: Action;
}

export interface EntityCountry extends EntityBaseRich {
  code: string;
  nameUa: string;
  icon?: string;
}

export interface EntityBrand extends EntityBaseRich {
  name: string;
}

export interface EntityType extends EntityBaseRich {
  name: string;
}

export interface EntityFlavor extends EntityBaseRich {
  name: string;
}

export interface EntityStore extends EntityBaseRich {
  slug: string;
  name: string;
  baseUrl: string;
  color?: string;
  active: boolean;
}

export interface EntityStoreConfig extends EntityBaseRich {
  storeId: ID;
  tier: number;
  delayFrom: number;
  delayTo: number;
  needsBrowser: boolean;
  retailChain?: string;
  category?: string;
  group?: string;
  engine: string;
}

/**
 * A bottling, independent of who sells it: what the whisky is, not what it
 * costs. Several stores' offers (`EntityStoreProduct`) point at one of these,
 * which is what lets an edit, a flavor classification or a photo be stored
 * once and read everywhere.
 */
export interface EntityProduct extends EntityBaseRich {
  /**
   * The cross-store identity of the bottling (`ProductMatchUtils.key`): a
   * normalized signature of name, brand, volume and age. Unique, and **frozen
   * at creation** — a later rename or a filled-in volume does not re-derive
   * it, because re-keying would silently detach the offers already linked.
   * Two rows that turn out to be one product are merged by hand.
   *
   * Null when no significant word survived normalization, which means the row
   * cannot be matched and stays on its own.
   */
  matchKey?: string;
  name?: string;
  age?: number;
  abv?: number;
  volumeMl?: number;
  brandId?: ID;
  typeId?: ID;
  countryId?: ID;
  /**
   * When the LLM flavor pass last answered for this product. Set even when the
   * answer was "unknown" (which links no flavor at all), so the marker is the
   * only way to tell "never asked" from "asked, recognized nothing" — a
   * product with no flavor links looks identical either way.
   */
  lastLlmFlavorAt?: Date;
  /**
   * When someone last set this product's flavors by hand. Once set, the tag set
   * is a person's decision and both automatic passes leave it alone: the
   * keyword pass adds nothing to it and the LLM pass is never asked about it.
   * Without that lock a removed tag would come back on the next sync, since the
   * keyword pass re-contributes whatever the listing still says.
   */
  flavorsCuratedAt?: Date;
}

/**
 * One store's offer of a bottling: its own SKU, page, availability and the
 * dates it was seen. Prices hang off this row, not off the product, and the
 * sweep flips `inStock` here.
 */
export interface EntityStoreProduct extends EntityBaseRich {
  storeId: ID;
  /**
   * The bottling this is an offer of. Assigned once, when the SKU is first
   * seen, and never rewritten by a sync — so moving an offer to another
   * product is a durable manual correction.
   */
  productId: ID;
  sku: string;
  url: string;
  nameOrig: string;
  inStock: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface EntityPriceSnapshot extends EntityBaseRich {
  storeProductId: ID;
  price: number;
  oldPrice?: number;
  currency: string;
  inStock: boolean;
  promo: boolean;
  capturedOn: string;
}

/**
 * One user's favorite bottling. Composite-keyed on `(userId, productId)` with
 * no surrogate id and no `updatedAt`: the row either exists or it does not, and
 * there is nothing about it to update.
 */
export interface EntityFavorite {
  /**
   * The user who favorited the bottling.
   */
  userId: ID;

  /**
   * The favorited bottling (`product.id`), never a store offer — a favorite is
   * a whisky, not one shop's listing of it.
   */
  productId: ID;

  /**
   * When the favorite was added. Kept so the eventual management screen can
   * order by it; nothing in the report reads it.
   */
  createdAt: Date;
}

/**
 * A bottling one user has hidden. Every report filters these out, in every
 * store, for that user only.
 */
export interface EntityBlacklistProduct {
  /**
   * The user who hid the bottling.
   */
  userId: ID;

  /**
   * The hidden bottling (`product.id`).
   */
  productId: ID;

  /**
   * When the bottling was hidden.
   */
  createdAt: Date;
}

/**
 * A brand one user has hidden. Broader than a product entry: it removes every
 * bottling the brand is resolved on, including ones listed later.
 */
export interface EntityBlacklistBrand {
  /**
   * The user who hid the brand.
   */
  userId: ID;

  /**
   * The hidden brand (`brand.id`). Products with no brand resolved are never
   * matched by a brand entry — there is no "unknown brand" to hide.
   */
  brandId: ID;

  /**
   * When the brand was hidden.
   */
  createdAt: Date;
}

/**
 * One browser's push subscription, owned by one user. A browser profile holds
 * at most one subscription per origin, so `endpoint` is globally unique and a
 * re-subscribe from the same profile is an upsert, not a second row.
 */
export interface EntityPushSubscription extends EntityBaseRich {
  /**
   * The user notified through this subscription. Reassigned on upsert when
   * the same browser profile signs into another account.
   */
  userId: ID;

  /**
   * The push service URL the payload is POSTed to. Unique — it identifies the
   * browser installation, not the user.
   */
  endpoint: string;

  /**
   * Client public key (base64url), used by the `web-push` library to encrypt
   * the payload for this subscription.
   */
  p256dh: string;

  /**
   * Client auth secret (base64url), the second half of the encryption input.
   */
  auth: string;

  /**
   * The subscribing browser's User-Agent, kept only so a device list is
   * tellable apart by a human.
   */
  userAgent?: string;

  /**
   * When a push was last accepted by the push service for this subscription.
   */
  lastSuccessAt?: Date;
}

/**
 * One offer's price drop already claimed by a digest dispatch. Composite-keyed
 * on `(userId, storeProductId, capturedOn)` like the preference memberships:
 * the row either exists or it does not, and its presence is what makes a
 * second dispatch of the same day skip the drop.
 */
export interface EntityPushDigestLog {
  /**
   * The user the drop was included in a digest for.
   */
  userId: ID;

  /**
   * The store offer whose price dropped.
   */
  storeProductId: ID;

  /**
   * The capture day (`YYYY-MM-DD`) the drop was observed on.
   */
  capturedOn: string;

  /**
   * The dropped price, kept for auditing what was actually announced.
   */
  price: number;

  /**
   * The previous recorded price the drop was measured against.
   */
  previousPrice: number;

  /**
   * When the digest claimed the drop.
   */
  createdAt: Date;
}

/**
 * One user's named, saved catalogue filter set.
 */
export interface EntityQuickFilter extends EntityBaseRich {
  /**
   * The owning user. Sets are strictly private — nothing shares them.
   */
  userId: ID;

  /**
   * The user-chosen name, unique per user (case-insensitively).
   */
  name: string;

  /**
   * The saved filters, stored as `jsonb` and never interpreted here. See
   * `QuickFilterPayload` for why the backend stays blind to its keys.
   */
  filters: Record<string, unknown>;
}

export interface EntitySyncLog extends EntityBaseRich {
  storeId: ID;
  added: number;
  removed: number;
  updated: number;
  total: number;
  success?: boolean;
  error?: string;
  finishedAt?: Date;
  group?: string;
  trigger?: string;
  logFile?: string;
}
