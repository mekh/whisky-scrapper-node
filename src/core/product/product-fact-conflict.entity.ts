import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import {
  FACT_ATTRIBUTE_MAX_LENGTH,
  FACT_CONFLICT_VALUE_MAX_LENGTH,
  KB_ENUM_MAX_LENGTH,
} from '~constants';
import { FactSource, ProductFactField } from '~enums';
import type {
  EntityProduct,
  EntityProductFactConflict,
  EntityStore,
  ID,
} from '~types';

/**
 * A recorded disagreement between the catalogue's value for a bottling and
 * what one store's listing claims.
 *
 * This is the log the "different sources of truth, different data" problem
 * needs. The canonical write silently discards a store's value whenever the
 * column is already filled — and that discarded claim was the only evidence
 * that two sources disagreed. It is kept here instead, so the disagreement can
 * be reviewed and the unreliable source named.
 *
 * It has to be written at scrape time: `rawAttrs` is never persisted, so no
 * later script can reconstruct what a store said.
 *
 * One row per (product, store, attribute) with `seenCount` bumped on each
 * sighting, rather than one row per day — a long-standing disagreement must not
 * grow the table daily.
 *
 * `age` and `volumeMl` are deliberately never compared. Both are components of
 * the frozen match key, so a store stating a different one is describing a
 * **different bottling** — a merge question, not a fact conflict — and
 * comparing them would bury the real findings under hundreds of structural
 * false positives.
 */
@Entity('product_fact_conflict')
@Index('product_fact_conflict_attribute_idx', ['attribute'])
@Index('product_fact_conflict_store_idx', ['storeId'])
export class ProductFactConflictEntity implements EntityProductFactConflict {
  @PrimaryColumn('uuid')
  public productId!: ID;

  @PrimaryColumn('uuid')
  public storeId!: ID;

  @IsEnum(ProductFactField)
  @PrimaryColumn({ type: 'varchar', length: FACT_ATTRIBUTE_MAX_LENGTH })
  public attribute!: ProductFactField;

  @IsOptional()
  @IsString()
  @MaxLength(FACT_CONFLICT_VALUE_MAX_LENGTH)
  @Column({ length: FACT_CONFLICT_VALUE_MAX_LENGTH, nullable: true })
  public storedValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(FACT_CONFLICT_VALUE_MAX_LENGTH)
  @Column({ length: FACT_CONFLICT_VALUE_MAX_LENGTH, nullable: true })
  public claimedValue?: string;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public storedSource?: FactSource;

  @IsInt()
  @Column({ type: 'int', default: 1 })
  public seenCount!: number;

  @IsDate()
  @CreateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public firstSeenAt!: Date;

  @IsDate()
  @Column({
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public lastSeenAt!: Date;

  @IsOptional()
  @IsDate()
  @Column({ type: 'timestamp', nullable: true })
  public resolvedAt?: Date;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_fact_conflict_product',
    name: 'productId',
  })
  public product!: EntityProduct;

  @ManyToOne(
    'StoreEntity',
    (store: EntityStore) => store.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_fact_conflict_store',
    name: 'storeId',
  })
  public store!: EntityStore;
}
