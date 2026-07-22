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
}

export interface EntityProduct extends EntityBaseRich {
  storeId: ID;
  sku: string;
  url: string;
  name?: string;
  nameOrig: string;
  age?: number;
  abv?: number;
  volumeMl?: number;
  brandId?: ID;
  typeId?: ID;
  countryId?: ID;
  firstSeen: string;
  lastSeen: string;
}

export interface EntityPriceSnapshot extends EntityBaseRich {
  productId: ID;
  price: number;
  oldPrice?: number;
  currency: string;
  inStock: boolean;
  promo: boolean;
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
}
