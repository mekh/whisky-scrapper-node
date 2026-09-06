import { IsNumber, IsOptional, IsString } from 'class-validator';

import type { CurrencyRateProbe } from '~types';

export class CurrencyRateType implements CurrencyRateProbe {
  @IsString()
  public code!: string;

  @IsString()
  public requestedOn!: string;

  @IsOptional()
  @IsString()
  public effectiveOn!: string | null;

  @IsOptional()
  @IsNumber()
  public rate!: number | null;
}
