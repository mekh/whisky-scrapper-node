import { IsNumber, IsString } from 'class-validator';

import type { CurrencyRatePoint } from '~types';

export class CurrencyRatePointType implements CurrencyRatePoint {
  @IsString()
  public effectiveOn!: string;

  @IsNumber()
  public rate!: number;
}
