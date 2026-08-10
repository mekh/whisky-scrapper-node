import { IsString, MaxLength } from 'class-validator';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { FLAVOR_SOURCE_MAX_LENGTH } from '~constants';
import { DEFAULT_FLAVOR_SOURCE, FlavorSource } from '~enums';
import type { EntityFlavor, EntityProduct, ID } from '~types';

/**
 * Explicit join entity for `product` <-> `flavor`. It replaces the implicit
 * `@JoinTable` junction that used to back `ProductEntity.flavors`, because
 * TypeORM's automatic many-to-many table cannot carry a column beyond the two
 * foreign keys and `source` needs one.
 *
 * Nothing loads this through TypeORM relations: `ProductRepository` manages
 * every row with raw SQL, as it already did for the implicit table. The entity
 * exists so the column is part of the model and `migration:generate` stays
 * drift-free.
 */
@Entity('product_flavor')
export class ProductFlavorEntity {
  @PrimaryColumn('uuid')
  @Index()
  public productId!: ID;

  @PrimaryColumn('uuid')
  @Index()
  public flavorId!: ID;

  @IsString()
  @MaxLength(FLAVOR_SOURCE_MAX_LENGTH)
  @Column({ length: FLAVOR_SOURCE_MAX_LENGTH, default: DEFAULT_FLAVOR_SOURCE })
  public source!: FlavorSource;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_flavor_product',
    name: 'productId',
  })
  public product!: EntityProduct;

  @ManyToOne(
    'FlavorEntity',
    (flavor: EntityFlavor) => flavor.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_flavor_flavor',
    name: 'flavorId',
  })
  public flavor!: EntityFlavor;
}
