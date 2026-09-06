import { IsNumber, IsOptional, IsString } from 'class-validator';

import type { CurrencyConversion } from '~types';

export class CurrencyConversionType implements CurrencyConversion {
  @IsNumber()
  public amount!: number;

  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsString()
  public requestedOn!: string;

  @IsOptional()
  @IsString()
  public effectiveOn!: string | null;

  @IsOptional()
  @IsNumber()
  public fromRate!: number | null;

  @IsOptional()
  @IsNumber()
  public toRate!: number | null;

  @IsNumber()
  public converted!: number;
}
