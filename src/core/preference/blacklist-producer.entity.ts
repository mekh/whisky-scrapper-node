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
  EntityBlacklistProducer,
  EntityProducer,
  EntityUser,
  ID,
} from '~types';

/**
 * A producer one user has hidden from every report. Same composite-key shape
 * as {@link FavoriteEntity}; see that entity for why the pair is the identity
 * and why the rows are managed in raw SQL by `PreferenceRepository`.
 *
 * Broader than a product entry: it hides every bottling the producer resolves
 * on, including ones the catalogue only lists later. The report predicate
 * tests the bottler slot as well as the distillery one, so hiding an
 * independent bottler hides what it released rather than nothing.
 *
 * The API still calls these "brands", because that is the word a shopper uses
 * and the word `/preference` has always answered with. What changed underneath
 * is that a rule now names one curated producer instead of one of the several
 * `brand` rows a maker used to be spelled across — hiding `Chivas` and
 * `Chivas Regal` separately, as one user had to, is no longer possible.
 */
@Entity('blacklist_producer')
export class BlacklistProducerEntity implements EntityBlacklistProducer {
  @PrimaryColumn('uuid')
  @Index('blacklist_producer_user_idx')
  public userId!: ID;

  @PrimaryColumn('uuid')
  @Index('blacklist_producer_producer_idx')
  public producerId!: ID;

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
    foreignKeyConstraintName: 'fk_blacklist_producer_user',
    name: 'userId',
  })
  public user!: EntityUser;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_blacklist_producer_producer',
    name: 'producerId',
  })
  public producer!: EntityProducer;
}
