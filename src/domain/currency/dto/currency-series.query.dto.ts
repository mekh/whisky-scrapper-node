import { IsString } from 'class-validator';

import { IsoDate } from '~decorators/fields';

/**
 * `GET /currency/rate/series` — one currency's rates over a day range.
 */
export class CurrencySeriesQueryDto {
  @IsString()
  public code!: string;

  @IsoDate()
  public from!: string;

  @IsoDate()
  public to!: string;
}
