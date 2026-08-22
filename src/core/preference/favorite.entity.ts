import { IsDate } from 'class-validator';
import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import type { EntityFavorite, EntityProduct, EntityUser, ID } from '~types';

/**
 * A user's favorite bottling. Composite-keyed like `ProductFlavorEntity` and
 * for the same reason: the pair itself is the identity, so a surrogate id would
 * only add a second way to say the same thing.
 *
 * It does carry `createdAt`, unlike that entity, so the blacklist/favorites
 * management screen this feature defers can order by when an entry was added.
 * There is nothing to update about a membership row, hence no `updatedAt` and
 * no `BaseRichEntity`.
 *
 * Nothing loads this through TypeORM relations: `PreferenceRepository` manages
 * every row with raw SQL. The entity exists so the table is part of the model
 * and `migration:generate` stays drift-free.
 */
@Entity('favorite')
export class FavoriteEntity implements EntityFavorite {
  @PrimaryColumn('uuid')
  @Index('favorite_user_idx')
  public userId!: ID;

  @PrimaryColumn('uuid')
  @Index('favorite_product_idx')
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
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_favorite_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_favorite_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
