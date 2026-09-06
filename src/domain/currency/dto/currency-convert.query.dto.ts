import { Type } from 'class-transformer';
import { IsNumber, IsString } from 'class-validator';

import { CurrencyConvertRequest } from '~types';

import { IsoDate } from '~decorators/fields';

/**
 * `GET /currency/convert` — one amount at one day's official rate.
 */
export class CurrencyConvertQueryDto implements CurrencyConvertRequest {
  @Type(() => Number)
  @IsNumber()
  public amount!: number;

  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsoDate(true)
  public date?: string;
}
