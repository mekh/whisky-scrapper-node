import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  COLLECTION_BARCODE_MAX_LENGTH,
  COLLECTION_BARCODE_PATTERN,
  COLLECTION_NOTE_MAX_LENGTH,
  COLLECTION_RATING_MAX,
  COLLECTION_RATING_MIN,
  COLLECTION_RATING_PRECISION,
  COLLECTION_RATING_SCALE,
} from '~constants';
import { GuidV7Column, NumericColumn } from '~decorators/columns';
import type {
  EntityProduct,
  EntityUser,
  EntityUserCollection,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One whisky in one user's personal collection.
 *
 * There is exactly one row per `(userId, productId)` pair, which is what the
 * unique index below enforces. That index is deliberately the *only* one
 * touching these two columns: leading with `userId` lets it serve every
 * per-user lookup on its own, exactly as `quick_filter_user_name_uindex` does
 * for `QuickFilterEntity`, so there is no separate `userId` index. It also
 * answers the question a catalogue screen actually asks — "does *this* user
 * already hold this bottling" — which is what lets such a screen show an
 * unambiguous "already in collection" mark against a resolved product.
 *
 * `productId` is `RESTRICT`, not `CASCADE`: unlike `favorite.productId`,
 * which protects nothing but a throwaway boolean, this row carries
 * irreplaceable user data — a rating, tasting notes — that a curation merge
 * must not silently delete. A merge has to re-point these rows to the
 * surviving bottling first, exactly as it already must for `store_product`.
 */
@Entity('user_collection')
/**
 * Mirrors the 0..10 bound `COLLECTION_RATING_MIN`/`COLLECTION_RATING_MAX`
 * state in TypeScript; the CHECK is the database-level backstop for any
 * write that does not go through the validated entity.
 */
@Check(
  'user_collection_rating_check',
  '"rating" IS NULL OR ("rating" >= 0 AND "rating" <= 10)',
)
/**
 * Mirrors `COLLECTION_BARCODE_PATTERN` — digits only, 8 to 14 of them.
 */
@Check(
  'user_collection_barcode_check',
  '"barcode" IS NULL OR "barcode" ~ \'^[0-9]{8,14}$\'',
)
@Index(
  'user_collection_user_product_uindex',
  ['userId', 'productId'],
  { unique: true },
)
export class UserCollectionEntity extends BaseRichEntity
  implements EntityUserCollection {
  @GuidV7Column()
  public userId!: ID;

  @GuidV7Column()
  public productId!: ID;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: COLLECTION_RATING_SCALE })
  @Min(COLLECTION_RATING_MIN)
  @Max(COLLECTION_RATING_MAX)
  @NumericColumn({
    precision: COLLECTION_RATING_PRECISION,
    scale: COLLECTION_RATING_SCALE,
    nullable: true,
  })
  public rating?: number;

  @IsOptional()
  @Matches(COLLECTION_BARCODE_PATTERN)
  @Column({ length: COLLECTION_BARCODE_MAX_LENGTH, nullable: true })
  public barcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  @Column({ type: 'text', nullable: true })
  public notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  @Column({ type: 'text', nullable: true })
  public nose?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  @Column({ type: 'text', nullable: true })
  public palate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  @Column({ type: 'text', nullable: true })
  public finish?: string;

  @ManyToOne(
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_user_collection_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'ProductEntity',
    (product: EntityProduct) => product.id,
    { onDelete: 'RESTRICT' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_user_collection_product',
    name: 'productId',
  })
  public product!: EntityProduct;
}
