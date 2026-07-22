import { IsNumber, IsString } from 'class-validator';

import { PriceHistoryPoint } from '~types';

export class PriceHistoryPointType implements PriceHistoryPoint {
  @IsString()
  public date!: string;

  @IsNumber()
  public price!: number;
}
