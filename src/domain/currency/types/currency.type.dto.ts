import { IsBoolean, IsInt, IsString } from 'class-validator';

import type { CurrencyOption } from '~types';

export class CurrencyType implements CurrencyOption {
  @IsString()
  public code!: string;

  @IsInt()
  public numericCode!: number;

  @IsString()
  public nameUa!: string;

  @IsString()
  public symbol!: string;

  @IsBoolean()
  public isBase!: boolean;
}
