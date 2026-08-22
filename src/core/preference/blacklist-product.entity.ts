import { IsDate } from 'class-validator';
import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import type {
  EntityBlacklistProduct,
  EntityProduct,
  EntityUser,
  ID,
} from '~types';

/**
 * A bottling one user has hidden from every report. Same composite-key shape as
 * {@link FavoriteEntity}; see that entity for why the pair is the identity and
 * why the rows are managed in raw SQL by `PreferenceRepository`.
 */
@Entity('blacklist_product')
export class BlacklistProductEntity implements EntityBlacklistProduct {
  @PrimaryColumn('uuid')
  @Index('blacklist_product_user_idx')
  public userId!: ID;

  @PrimaryColumn('uuid')
  @Index('blacklist_product_product_idx')
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
    foreignKeyConstraintName: 'fk_blacklist_product_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_blacklist_product_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
