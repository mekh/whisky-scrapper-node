import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { FLAVOR_RULE_PATTERN_MAX_LENGTH } from '~constants';
import { FlavorRuleMatchMode, KbFlavorEffect, PeatProfile } from '~enums';

import type { ProducerRuleCreateInput } from '../product-review.interfaces';

/**
 * The effects a reviewer's tag rule may state. `baseline` is deliberately
 * absent — it belongs to the house style (`producer_flavor`), not to a name
 * rule, and offering it here would create a second place to state it.
 */
const RULE_EFFECTS = [KbFlavorEffect.REQUIRE, KbFlavorEffect.FORBID];

/**
 * The peat bands a reviewer's rule may state. `unknown` is deliberately
 * absent: a rule exists to assert something, and "this name implies we do not
 * know" asserts nothing a missing rule would not.
 */
const RULE_PEAT_PROFILES = [
  PeatProfile.NONE,
  PeatProfile.LIGHT,
  PeatProfile.MEDIUM,
  PeatProfile.HEAVY,
];

/**
 * Ceiling for a reviewer's priority. Negations sit at 100 by convention, and
 * nothing seeded goes higher — a rule that must beat a negation is a sign the
 * negation itself is wrong.
 */
const MAX_PRIORITY = 100;

/**
 * Longest accepted note.
 */
const MAX_NOTE_LENGTH = 500;

export class ProducerRuleCreateDto implements ProducerRuleCreateInput {
  @IsString()
  @MinLength(2)
  @MaxLength(FLAVOR_RULE_PATTERN_MAX_LENGTH)
  public pattern!: string;

  @IsOptional()
  @IsEnum(FlavorRuleMatchMode)
  public matchMode?: FlavorRuleMatchMode;

  @IsOptional()
  @IsIn(RULE_PEAT_PROFILES)
  public peatProfile?: PeatProfile;

  @IsOptional()
  @IsString()
  public flavorName?: string;

  @IsOptional()
  @IsIn(RULE_EFFECTS)
  public effect?: KbFlavorEffect;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_PRIORITY)
  public priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_NOTE_LENGTH)
  public note?: string;
}
