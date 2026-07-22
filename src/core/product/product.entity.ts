import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';

import {
  PRODUCT_NAME_MAX_LENGTH,
  PRODUCT_SKU_MAX_LENGTH,
  PRODUCT_URL_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type {
  EntityBrand,
  EntityCountry,
  EntityFlavor,
  EntityProduct,
  EntityStore,
  EntityType,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

@Entity('product')
@Index('product_store_sku_uindex', ['storeId', 'sku'], { unique: true })
export class ProductEntity extends BaseRichEntity implements EntityProduct {
  @GuidV7Column()
  public storeId!: ID;

  @IsString()
  @MaxLength(PRODUCT_SKU_MAX_LENGTH)
  @Column({ length: PRODUCT_SKU_MAX_LENGTH })
  public sku!: string;

  @IsString()
  @MaxLength(PRODUCT_URL_MAX_LENGTH)
  @Column({ length: PRODUCT_URL_MAX_LENGTH })
  public url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  @Column({ length: PRODUCT_NAME_MAX_LENGTH, nullable: true })
  public name?: string;

  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  @Column({ length: PRODUCT_NAME_MAX_LENGTH })
  public nameOrig!: string;

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
    foreignKeyConstraintName: 'fk_product_store',
    name: 'storeId',
  })
  public store!: EntityStore;

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

  @ManyToMany('FlavorEntity')
  @JoinTable({
    name: 'product_flavor',
    joinColumn: {
      name: 'productId',
      foreignKeyConstraintName: 'fk_product_flavor_product',
    },
    inverseJoinColumn: {
      name: 'flavorId',
      foreignKeyConstraintName: 'fk_product_flavor_flavor',
    },
  })
  public flavors!: EntityFlavor[];
}
