import {
  IsDate,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  PRODUCT_MATCH_KEY_MAX_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type {
  EntityBrand,
  EntityCountry,
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
 */
@Entity('product')
@Index('product_match_key_uindex', ['matchKey'], { unique: true })
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

  @GuidV7Column({ nullable: true })
  public brandId?: ID;

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

  @ManyToOne(
    'BrandEntity',
    (brand: EntityBrand) => brand.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_brand',
    name: 'brandId',
  })
  public brand?: EntityBrand;

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
}
