import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';

import type { CurrencyRateSeries } from '~types';

import { CurrencyRatePointType } from './currency-rate-point.type.dto';

export class CurrencyRateSeriesType implements CurrencyRateSeries {
  @IsString()
  public code!: string;

  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CurrencyRatePointType)
  public points!: CurrencyRatePointType[];
}
