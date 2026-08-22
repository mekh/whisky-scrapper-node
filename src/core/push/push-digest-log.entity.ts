import { IsDate } from 'class-validator';
import {
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { NumericColumn } from '~decorators/columns';
import type {
  EntityPushDigestLog,
  EntityStoreProduct,
  EntityUser,
  ID,
} from '~types';

/**
 * One offer's price drop already claimed by a digest dispatch. Composite-keyed
 * like `FavoriteEntity` and for the same reason: the triple is the identity,
 * and the atomic `INSERT … ON CONFLICT DO NOTHING RETURNING` claim in
 * `PushRepository` is what keeps a second same-day dispatch from repeating a
 * drop. There is nothing to update, hence no `updatedAt` and no
 * `BaseRichEntity`.
 *
 * Nothing loads this through TypeORM relations: `PushRepository` manages every
 * row with raw SQL. The entity exists so the table is part of the model and
 * `migration:generate` stays drift-free.
 */
@Entity('push_digest_log')
@Index('push_digest_log_captured_idx', ['capturedOn'])
export class PushDigestLogEntity implements EntityPushDigestLog {
  @PrimaryColumn('uuid')
  public userId!: ID;

  @PrimaryColumn('uuid')
  public storeProductId!: ID;

  @PrimaryColumn({ type: 'date' })
  public capturedOn!: string;

  @NumericColumn()
  public price!: number;

  @NumericColumn()
  public previousPrice!: number;

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
    foreignKeyConstraintName: 'fk_push_digest_log_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'StoreProductEntity',
    (storeProduct: EntityStoreProduct) => storeProduct.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_push_digest_log_store_product',
    name: 'storeProductId',
  })
  public storeProduct!: EntityStoreProduct;
}
