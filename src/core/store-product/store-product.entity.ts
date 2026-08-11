import { IsBoolean, IsDateString, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_SKU_MAX_LENGTH,
  PRODUCT_URL_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type {
  EntityProduct,
  EntityStore,
  EntityStoreProduct,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One store's offer of a bottling: the SKU it lists it under, its page, its
 * availability and the days it was first and last seen. Price snapshots hang
 * off this row, so a store's price history is independent of every other
 * store's.
 *
 * `productId` is assigned once, when the SKU is first seen, and no sync ever
 * rewrites it — the upsert leaves it out of its conflict-update clause on
 * purpose. That is what makes moving an offer to another bottling (the manual
 * correction for a mismatch) permanent.
 *
 * The delete rules differ by side and both are deliberate: dropping a store
 * cascades into its offers and their prices, which is what un-onboarding a
 * store means, while a canonical product is protected by `RESTRICT` — deleting
 * one has to start by relinking its offers, or it would take the price history
 * of every store with it.
 */
@Entity('store_product')
@Index('store_product_store_sku_uindex', ['storeId', 'sku'], { unique: true })
@Index('store_product_product_idx', ['productId'])
export class StoreProductEntity extends BaseRichEntity
  implements EntityStoreProduct {
  @GuidV7Column()
  public storeId!: ID;

  @GuidV7Column()
  public productId!: ID;

  @IsString()
  @MaxLength(PRODUCT_SKU_MAX_LENGTH)
  @Column({ length: PRODUCT_SKU_MAX_LENGTH })
  public sku!: string;

  @IsString()
  @MaxLength(PRODUCT_URL_MAX_LENGTH)
  @Column({ length: PRODUCT_URL_MAX_LENGTH })
  public url!: string;

  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  @Column({ length: PRODUCT_NAME_MAX_LENGTH })
  public nameOrig!: string;

  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  public inStock!: boolean;

  @IsDateString()
  @Column({ type: 'date' })
  public firstSeen!: string;

  @IsDateString()
  @Column({ type: 'date' })
  public lastSeen!: string;

  @ManyToOne(
    'StoreEntity',
    (store: EntityStore) => store.id,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_store_product_store',
    name: 'storeId',
  })
  public store!: EntityStore;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'RESTRICT' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_store_product_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
