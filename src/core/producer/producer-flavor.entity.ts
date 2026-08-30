import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { KB_ENUM_MAX_LENGTH } from '~constants';
import { KbFlavorEffect } from '~enums';
import type {
  EntityFlavor,
  EntityProducer,
  EntityProducerFlavor,
  ID,
} from '~types';

/**
 * A curated statement about a producer's house style, for the thirteen
 * non-peat flavor tags.
 *
 * Composite-keyed with no surrogate id and no `updatedAt`, following
 * `product_flavor` and the preference tables: the row is a statement that
 * either stands or is deleted.
 *
 * **`peated` may never appear here.** Peat has exactly one source of truth —
 * `producer.peatProfile` plus the peat rules — and a second one would
 * reintroduce the very disagreement that hid the user's favourite whisky. The
 * seed importer rejects such a row and a unit test pins it, since a CHECK
 * constraint cannot reach across to the `flavor` table to enforce it.
 *
 * `smoky` **is** allowed, because non-peat smokiness is a real house
 * characteristic: Jack Daniel's charcoal mellowing is the catalogue's clearest
 * case, and it keeps its tag through a `require` row here while carrying no
 * peat at all.
 */
@Entity('producer_flavor')
export class ProducerFlavorEntity implements EntityProducerFlavor {
  @PrimaryColumn('uuid')
  @Index()
  public producerId!: ID;

  @PrimaryColumn('uuid')
  @Index()
  public flavorId!: ID;

  @IsEnum(KbFlavorEffect)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH })
  public effect!: KbFlavorEffect;

  @IsOptional()
  @IsString()
  @MaxLength(KB_ENUM_MAX_LENGTH)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public confidence?: string;

  @IsOptional()
  @IsString()
  @Column({ type: 'text', nullable: true })
  public sourceUrls?: string;

  @IsOptional()
  @IsString()
  @Column({ type: 'text', nullable: true })
  public note?: string;

  @IsDate()
  @CreateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt!: Date;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_flavor_producer',
    name: 'producerId',
  })
  public producer!: EntityProducer;

  @ManyToOne(
    'FlavorEntity',
    (flavor: EntityFlavor) => flavor.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_flavor_flavor',
    name: 'flavorId',
  })
  public flavor!: EntityFlavor;
}
