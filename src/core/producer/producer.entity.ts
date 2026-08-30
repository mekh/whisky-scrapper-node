import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  KB_ENUM_MAX_LENGTH,
  PRODUCER_NAME_MAX_LENGTH,
  PRODUCER_OWNER_MAX_LENGTH,
  PRODUCER_SLUG_MAX_LENGTH,
  WHISKY_TYPE_NAME_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { EntityCountry, EntityProducer, ID } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * A curated knowledge-base entry — the single source of truth for the facts
 * that belong to a producer rather than to one bottling.
 *
 * All four kinds (distillery, brand, blend, bottler) share this table because
 * they share the aliases, the citations and the review workflow, and because a
 * name inside a product title does not announce which kind it is.
 *
 * Rows are reached through `producer_alias`, never through `product.brandId`:
 * the catalogue's brand names include typos (`Isiay Mist`, `Pear's Beast`),
 * duplicate spellings (`Macallan` beside `The Macallan`) and secret labels
 * (`An Orkney`, which is Highland Park), and every one of them has to resolve
 * to a single researched entry.
 */
@Entity('producer')
/**
 * `islands` is a market convention, not a protected region, so it may only
 * ever appear in `region`. Without this the two columns would drift into
 * saying the same thing and the distinction would quietly stop being worth
 * having.
 */
@Check('producer_legal_region_check', '"legalRegion" <> \'islands\'')
@Index('producer_slug_uindex', ['slug'], { unique: true })
@Index('producer_region_idx', ['region'])
@Index('producer_status_idx', ['status'])
export class ProducerEntity extends BaseRichEntity implements EntityProducer {
  @IsString()
  @MaxLength(PRODUCER_SLUG_MAX_LENGTH)
  @Column({ length: PRODUCER_SLUG_MAX_LENGTH })
  public slug!: string;

  @IsString()
  @MaxLength(PRODUCER_NAME_MAX_LENGTH)
  @Column({ length: PRODUCER_NAME_MAX_LENGTH })
  public name!: string;

  @IsEnum(ProducerKind)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH })
  public kind!: ProducerKind;

  @GuidV7Column({ nullable: true })
  public countryId?: ID;

  @IsOptional()
  @IsEnum(ScotlandRegion)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public region?: ScotlandRegion;

  @IsOptional()
  @IsEnum(ScotlandLegalRegion)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public legalRegion?: ScotlandLegalRegion;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCER_OWNER_MAX_LENGTH)
  @Column({ length: PRODUCER_OWNER_MAX_LENGTH, nullable: true })
  public owner?: string;

  @GuidV7Column({ nullable: true })
  public parentId?: ID;

  @GuidV7Column({ nullable: true })
  public bottlerId?: ID;

  @IsOptional()
  @IsString()
  @MaxLength(WHISKY_TYPE_NAME_MAX_LENGTH)
  @Column({ length: WHISKY_TYPE_NAME_MAX_LENGTH, nullable: true })
  public defaultTypeName?: string;

  @IsEnum(PeatProfile)
  @Column({
    type: 'varchar',
    length: KB_ENUM_MAX_LENGTH,
    default: PeatProfile.UNKNOWN,
  })
  public peatProfile!: PeatProfile;

  @IsEnum(KbStatus)
  @Column({
    type: 'varchar',
    length: KB_ENUM_MAX_LENGTH,
    default: KbStatus.UNVERIFIED,
  })
  public status!: KbStatus;

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

  @IsOptional()
  @IsDate()
  @Column({ type: 'timestamp', nullable: true })
  public verifiedAt?: Date;

  @ManyToOne(
    'CountryEntity',
    (country: EntityCountry) => country.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_country',
    name: 'countryId',
  })
  public country?: EntityCountry;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_parent',
    name: 'parentId',
  })
  public parent?: EntityProducer;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'SET NULL', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_producer_bottler',
    name: 'bottlerId',
  })
  public bottler?: EntityProducer;
}
