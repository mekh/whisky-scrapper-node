import { IsNumber, IsString } from 'class-validator';

import type { CurrencyLatestRate } from '~types';

export class CurrencyLatestRateType implements CurrencyLatestRate {
  @IsString()
  public code!: string;

  @IsString()
  public effectiveOn!: string;

  @IsNumber()
  public rate!: number;
}
