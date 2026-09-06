import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { PRICE_SCALE, STORE_NAME_MAX_LENGTH } from '~constants';
import { GuidV7Column, NumericColumn } from '~decorators/columns';
import { IsoDate } from '~decorators/fields';
import type {
  EntityStore,
  EntityStoreProduct,
  EntityUserCollection,
  EntityUserCollectionPurchase,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One bottle bought against a collection item.
 *
 * An item may hold several of these (the same whisky bought more than once)
 * or none at all — a bottle only ever tasted at a bar, or received as a
 * gift, is still worth keeping in the collection with no purchase attached.
 *
 * `storeId` and `storeName` are mutually exclusive, enforced by the CHECK
 * below: a shop is either one of ours — joinable, colourable, the same row
 * every report reads — or the user's own free text ("duty free",
 * "подарунок"), never both at once.
 */
@Entity('user_collection_purchase')
@Check(
  'user_collection_purchase_price_check',
  '"price" IS NULL OR "price" >= 0',
)
/**
 * `num_nonnulls` counts how many of its arguments are non-null; at most one
 * of the pair may be set, and zero is the legitimate "no shop recorded" case.
 */
@Check(
  'user_collection_purchase_store_check',
  'num_nonnulls("storeId", "storeName") <= 1',
)
@Index(
  'user_collection_purchase_collection_idx',
  ['collectionId', 'purchasedOn'],
)
export class UserCollectionPurchaseEntity extends BaseRichEntity
  implements EntityUserCollectionPurchase {
  @GuidV7Column()
  public collectionId!: ID;

  @IsoDate()
  @Column({ type: 'date', default: () => 'CURRENT_DATE' })
  public purchasedOn!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PRICE_SCALE })
  @Min(0)
  @NumericColumn({ nullable: true })
  public price?: number;

  @GuidV7Column({ nullable: true })
  public storeId?: ID;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_NAME_MAX_LENGTH)
  @Column({ length: STORE_NAME_MAX_LENGTH, nullable: true })
  public storeName?: string;

  @GuidV7Column({ nullable: true })
  public storeProductId?: ID;

  @ManyToOne(
    'UserCollectionEntity',
    (collection: EntityUserCollection) => collection.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_user_collection_purchase_collection',
    name: 'collectionId',
  })
  public collection!: EntityUserCollection;

  @ManyToOne(
    'StoreEntity',
    (store: EntityStore) => store.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_user_collection_purchase_store',
    name: 'storeId',
  })
  public store?: EntityStore;

  @ManyToOne(
    'StoreProductEntity',
    (storeProduct: EntityStoreProduct) => storeProduct.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_user_collection_purchase_offer',
    name: 'storeProductId',
  })
  public storeProduct?: EntityStoreProduct;
}
