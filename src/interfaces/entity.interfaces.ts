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
