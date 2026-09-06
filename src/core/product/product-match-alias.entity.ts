import { IsDate, IsString, MaxLength } from 'class-validator';
import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { PRODUCT_MATCH_KEY_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type { EntityProduct, EntityProductMatchAlias, ID } from '~types';

/**
 * A retired match key that still resolves to a bottling — see
 * `EntityProductMatchAlias` for why the table exists.
 *
 * Nothing loads this through TypeORM relations: `ProductRepository` writes
 * every row in raw SQL as part of a merge and reads the table ahead of every
 * find-or-create. The entity exists so the table is part of the model and
 * `migration:generate` stays drift-free, the `product_flavor` pattern.
 *
 * `ON DELETE CASCADE` is the right rule here and the opposite of what the
 * offers get: an alias is a pointer with no history of its own, so when its
 * bottling goes the pointer must go too rather than block the delete.
 */
@Entity('product_match_alias')
@Index('product_match_alias_product_idx', ['productId'])
export class ProductMatchAliasEntity implements EntityProductMatchAlias {
  @IsString()
  @MaxLength(PRODUCT_MATCH_KEY_MAX_LENGTH)
  @PrimaryColumn({ length: PRODUCT_MATCH_KEY_MAX_LENGTH })
  public key!: string;

  @GuidV7Column()
  public productId!: ID;

  @IsDate()
  @CreateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt!: Date;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_product_match_alias_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
