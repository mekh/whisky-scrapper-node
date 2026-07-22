import { IsOptional, IsString } from 'class-validator';

import { MetaCountry } from '~types';

export class MetaCountryType implements MetaCountry {
  @IsString()
  public code!: string;

  @IsString()
  public nameUa!: string;

  @IsOptional()
  @IsString()
  public icon!: string | null;
}
