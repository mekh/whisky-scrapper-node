import { IsDate } from 'class-validator';
import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import type { EntityBlacklistBrand, EntityBrand, EntityUser, ID } from '~types';

/**
 * A brand one user has hidden from every report. Same composite-key shape as
 * {@link FavoriteEntity}; see that entity for why the pair is the identity and
 * why the rows are managed in raw SQL by `PreferenceRepository`.
 *
 * Broader than a product entry: it hides every bottling the brand resolves on,
 * including ones the catalogue only lists later.
 */
@Entity('blacklist_brand')
export class BlacklistBrandEntity implements EntityBlacklistBrand {
  @PrimaryColumn('uuid')
  @Index('blacklist_brand_user_idx')
  public userId!: ID;

  @PrimaryColumn('uuid')
  @Index('blacklist_brand_brand_idx')
  public brandId!: ID;

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
    foreignKeyConstraintName: 'fk_blacklist_brand_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'BrandEntity',
    (brand: EntityBrand) => brand.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_blacklist_brand_brand',
    name: 'brandId',
  })
  public brand!: EntityBrand;
}
