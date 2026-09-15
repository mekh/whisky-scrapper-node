import {
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  BRAND_NAME_MAX_LENGTH,
  KB_ENUM_MAX_LENGTH,
  PRODUCT_MATCH_KEY_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import { FactSource, ProductReviewStatus } from '~enums';
import type {
  EntityCountry,
  EntityProducer,
  EntityProduct,
  EntityType,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * A bottling, independent of who sells it. One row per whisky; the stores'
 * offers hang off it through `store_product`, and everything a buyer would
 * call a property of the whisky itself — name, brand, strength, size, age,
 * origin, flavors — lives here, so it is stored and corrected once.
 *
 * `matchKey` is the identity. It is derived, unique, and frozen at creation:
 * see `ProductMatchUtils` for how it is built and `EntityProduct` for why
 * nothing re-derives it.
 *
 * Every fact field carries a `<field>Source` column recording where its value
 * came from ({@link FactSource}). The columns are what make the catalogue
 * correctable: a value is overwritten only by a better-ranked source, a
 * hand-edited one is never overwritten at all, and a value that is still only
 * a model's guess can be told apart from one a distillery states.
 */
@Entity('product')
@Index('product_match_key_uindex', ['matchKey'], { unique: true })
@Index('product_producer_idx', ['producerId'])
@Index('product_bottler_idx', ['bottlerId'])
@Index('product_review_status_idx', ['reviewStatus'])
export class ProductEntity extends BaseRichEntity implements EntityProduct {
  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_MATCH_KEY_MAX_LENGTH)
  @Column({ length: PRODUCT_MATCH_KEY_MAX_LENGTH, nullable: true })
  public matchKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  @Column({ length: PRODUCT_NAME_MAX_LENGTH, nullable: true })
  public name?: string;

  @IsInt()
  @IsOptional()
  @Column({ type: 'int', nullable: true })
  public age?: number;

  @IsNumber()
  @IsOptional()
  @Column({ type: 'real', nullable: true })
  public abv?: number;

  @IsInt()
  @IsOptional()
  @Column({ type: 'int', nullable: true })
  public volumeMl?: number;

  @IsString()
  @IsOptional()
  @MaxLength(BRAND_NAME_MAX_LENGTH)
  @Column({ length: BRAND_NAME_MAX_LENGTH, nullable: true })
  public brandOrig?: string;

  @GuidV7Column({ nullable: true })
  public typeId?: ID;

  @GuidV7Column({ nullable: true })
  public countryId?: ID;

  @IsDate()
  @IsOptional()
  @Column({ type: 'timestamp', nullable: true })
  public lastLlmFlavorAt?: Date;

  @IsDate()
  @IsOptional()
  @Column({ type: 'timestamp', nullable: true })
  public flavorsCuratedAt?: Date;

  @GuidV7Column({ nullable: true })
  public producerId?: ID;

  @GuidV7Column({ nullable: true })
  public bottlerId?: ID;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public nameSource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public typeSource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public countrySource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public abvSource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public ageSource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public volumeSource?: FactSource;

  @IsOptional()
  @IsEnum(FactSource)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public producerSource?: FactSource;

  /**
   * How far this bottling has been through the new-product queue, or null when
   * it never entered it — see {@link ProductReviewStatus} for the four states
   * and for why null is one of them.
   *
   * **The default lives in the database, and that is on purpose.** Three
   * different statements insert into this table and none of them names this
   * column; the column default is what enrols every row they create, and what
   * a fourth insert path added later would inherit for free. Stating it in the
   * three column lists instead would be three copies of one constant, and a
   * bottling that never reaches the queue is invisible by construction.
   *
   * The other half of that is `FIND_OR_CREATE_SQL`'s no-op `ON CONFLICT DO
   * UPDATE`, which does not touch this column: a bottling somebody has already
   * reviewed is not pushed back into the queue when a shop lists it again
   * tomorrow.
   */
  @IsOptional()
  @IsEnum(ProductReviewStatus)
  @Column({
    type: 'varchar',
    length: KB_ENUM_MAX_LENGTH,
    nullable: true,
    default: ProductReviewStatus.PENDING,
  })
  public reviewStatus?: ProductReviewStatus;

  /**
   * When a person last decided about this bottling.
   */
  @IsDate()
  @IsOptional()
  @Column({ type: 'timestamp', nullable: true })
  public reviewedAt?: Date;

  @ManyToOne(
    'TypeEntity',
    (type: EntityType) => type.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_type',
    name: 'typeId',
  })
  public type?: EntityType;

  @ManyToOne(
    'CountryEntity',
    (country: EntityCountry) => country.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_country',
    name: 'countryId',
  })
  public country?: EntityCountry;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_producer',
    name: 'producerId',
  })
  public producer?: EntityProducer;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_bottler',
    name: 'bottlerId',
  })
  public bottler?: EntityProducer;
}
