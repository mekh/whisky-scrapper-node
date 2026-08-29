import { IsInt, IsOptional, IsString } from 'class-validator';

import type { FlavorRuleMatchMode, KbFlavorEffect, PeatProfile } from '~enums';
import type { ProducerRuleRow } from '~types';

export class ProducerRuleType implements ProducerRuleRow {
  @IsString()
  public pattern!: string;

  @IsString()
  public matchMode!: FlavorRuleMatchMode;

  @IsOptional()
  @IsString()
  public flavorName!: string | null;

  @IsOptional()
  @IsString()
  public effect!: KbFlavorEffect | null;

  @IsOptional()
  @IsString()
  public peatProfile!: PeatProfile | null;

  @IsInt()
  public priority!: number;

  @IsOptional()
  @IsString()
  public sourceUrls!: string | null;

  @IsOptional()
  @IsString()
  public note!: string | null;
}
