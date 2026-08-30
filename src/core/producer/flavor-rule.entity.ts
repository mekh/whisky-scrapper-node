import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { FLAVOR_RULE_PATTERN_MAX_LENGTH, KB_ENUM_MAX_LENGTH } from '~constants';
import { GuidV7Column } from '~decorators/columns';
import { FlavorRuleMatchMode, KbFlavorEffect, PeatProfile } from '~enums';
import type {
  EntityFlavor,
  EntityFlavorRule,
  EntityProducer,
  ID,
} from '~types';

import { BaseRichEntity } from '../_common';

/**
 * A deterministic rule keyed on a pattern in the product name, covering the
 * facts that vary between one producer's own bottlings.
 *
 * This table is why `PeatProfile` needs no `variable` band: Bruichladdich is
 * unpeated, and `Port Charlotte` or `Octomore` in the name is what makes a
 * bottling heavily peated. The same shape handles `Bunnahabhain Mòine`,
 * `BenRiach The Smoky`, `Benromach Unpeated` and the cask qualifiers
 * (`Oloroso` implying sherry).
 *
 * Patterns are plain normalized strings, never regular expressions, because a
 * peat rule has to be reviewable by someone who does not read regex.
 *
 * A row is either a peat rule or a tag rule, never both — enforced by a CHECK
 * constraint in the migration, so a row cannot half-state two things. A
 * pattern implying two tags is two rows (`bourbon cask` -> `bourbon-cask`,
 * then `bourbon cask` -> `vanilla`).
 */
@Entity('flavor_rule')
/**
 * A row is either a tag rule or a peat rule, never both and never neither, so
 * it cannot half-state two different things.
 */
@Check(
  'flavor_rule_kind_check',
  `("flavorId" IS NOT NULL AND "effect" IS NOT NULL AND "peatProfile" IS NULL)
    OR ("flavorId" IS NULL AND "effect" IS NULL
      AND "peatProfile" IS NOT NULL)`,
)
@Index('flavor_rule_producer_idx', ['producerId'])
/**
 * One rule per (producer, pattern, tag), with `NULLS NOT DISTINCT` so the two
 * nullable columns still collide — otherwise a global peat rule could be
 * seeded twice and the duplicate would sit there silently. The decorator
 * cannot express `NULLS NOT DISTINCT`, so the index is created by hand in the
 * migration and kept out of schema management, exactly as
 * `sync_log_running_uindex` is.
 */
@Index('flavor_rule_uindex', { synchronize: false })
export class FlavorRuleEntity extends BaseRichEntity
  implements EntityFlavorRule {
  @GuidV7Column({ nullable: true })
  public producerId?: ID;

  @IsString()
  @MaxLength(FLAVOR_RULE_PATTERN_MAX_LENGTH)
  @Column({ length: FLAVOR_RULE_PATTERN_MAX_LENGTH })
  public pattern!: string;

  @IsEnum(FlavorRuleMatchMode)
  @Column({
    type: 'varchar',
    length: KB_ENUM_MAX_LENGTH,
    default: FlavorRuleMatchMode.WORD,
  })
  public matchMode!: FlavorRuleMatchMode;

  @GuidV7Column({ nullable: true })
  public flavorId?: ID;

  @IsOptional()
  @IsEnum(KbFlavorEffect)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public effect?: KbFlavorEffect;

  @IsOptional()
  @IsEnum(PeatProfile)
  @Column({ type: 'varchar', length: KB_ENUM_MAX_LENGTH, nullable: true })
  public peatProfile?: PeatProfile;

  @IsInt()
  @Column({ type: 'int', default: 0 })
  public priority!: number;

  @IsOptional()
  @IsString()
  @Column({ type: 'text', nullable: true })
  public sourceUrls?: string;

  @IsOptional()
  @IsString()
  @Column({ type: 'text', nullable: true })
  public note?: string;

  @ManyToOne(
    'ProducerEntity',
    (producer: EntityProducer) => producer.id,
    { onDelete: 'CASCADE', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_flavor_rule_producer',
    name: 'producerId',
  })
  public producer?: EntityProducer;

  @ManyToOne(
    'FlavorEntity',
    (flavor: EntityFlavor) => flavor.id,
    { onDelete: 'CASCADE', nullable: true },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_flavor_rule_flavor',
    name: 'flavorId',
  })
  public flavor?: EntityFlavor;
}
