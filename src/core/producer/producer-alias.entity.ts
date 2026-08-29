import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { KB_ENUM_MAX_LENGTH, PRODUCER_ALIAS_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import { ProducerAliasScope } from '~enums';
import type { EntityProducer, EntityProducerAlias, ID } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One spelling that resolves to a producer, normalized by `KbKeyUtils.key`.
 *
 * The resolver's whole match index is this table, which is why it deliberately
 * carries the catalogue's own damage: `isiay mist` (a capital I read as an l),
 * `douglas laingcompany`, `pears beast`, plus Cyrillic spellings and the
 * distillery-name typos the Wishart dataset ships with. Enumerating the seed
 * from an external clean list instead would leave exactly those rows
 * unresolved.
 *
 * `key` is unique across every producer, so one spelling can never resolve two
 * ways — an ambiguity would otherwise surface as a silent, per-run coin flip.
 */
@Entity('producer_alias')
@Index('producer_alias_key_uindex', ['key'], { unique: true })
@Index('producer_alias_producer_idx', ['producerId'])
export class ProducerAliasEntity extends BaseRichEntity
  implements EntityProducerAlias {
  @IsString()
  @MaxLength(PRODUCER_ALIAS_MAX_LENGTH)
  @Column({ length: PRODUCER_ALIAS_MAX_LENGTH })
  public key!: string;

  @GuidV7Column()
  public producerId!: ID;

  @IsEnum(ProducerAliasScope)
  @Column({
    type: 'varchar',
    length: KB_ENUM_MAX_LENGTH,
    default: ProducerAliasScope.ANY,
  })
  public scope!: ProducerAliasScope;

  @IsOptional()
  @IsString()
  @Column({ type: 'text', nullable: true })
  public note?: string;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_alias_producer',
    name: 'producerId',
  })
  public producer!: EntityProducer;
}
