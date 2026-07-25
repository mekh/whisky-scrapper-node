import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CURRENCY_MAX_LENGTH, DEFAULT_CURRENCY } from '~constants';
import { GuidV7Column, NumericColumn } from '~decorators/columns';
import type { EntityPriceSnapshot, EntityProduct, ID } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('price_snapshot')
@Index('price_snapshot_product_created_idx', ['productId', 'createdAt'])
@Index(
  'price_snapshot_product_captured_uindex',
  ['productId', 'capturedOn'],
  { unique: true },
)
export class PriceSnapshotEntity extends BaseRichEntity
  implements EntityPriceSnapshot {
  @GuidV7Column()
  public productId!: ID;

  @IsNumber()
  @NumericColumn()
  public price!: number;

  @IsNumber()
  @IsOptional()
  @NumericColumn({ nullable: true })
  public oldPrice?: number;

  @IsString()
  @MaxLength(CURRENCY_MAX_LENGTH)
  @Column({ length: CURRENCY_MAX_LENGTH, default: DEFAULT_CURRENCY })
  public currency!: string;

  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  public inStock!: boolean;

  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  public promo!: boolean;

  // The calendar day this snapshot belongs to, as a UTC date. Paired with a
  // unique index on (productId, capturedOn) to enforce one row per product per
  // day at the database level, replacing the old app-only convention.
  @IsDateString()
  @Column({ type: 'date', default: () => 'CURRENT_DATE' })
  public capturedOn!: string;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_snapshot_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
