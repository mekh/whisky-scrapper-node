import { IsArray, IsInt, IsString } from 'class-validator';

import type { CurrencyRateSyncReport } from '~types';

export class CurrencyRateSyncReportType implements CurrencyRateSyncReport {
  @IsArray()
  @IsString({ each: true })
  public codes!: string[];

  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsInt()
  public fetched!: number;

  @IsInt()
  public written!: number;
}
