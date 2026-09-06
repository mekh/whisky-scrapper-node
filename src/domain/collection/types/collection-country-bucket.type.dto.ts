import { IsInt, IsOptional, IsString } from 'class-validator';

import type { CollectionCountryBucket } from '~types';

export class CollectionCountryBucketType implements CollectionCountryBucket {
  @IsString()
  public countryCode!: string;

  @IsOptional()
  @IsString()
  public countryName!: string | null;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;

  @IsInt()
  public bottles!: number;

  @IsInt()
  public items!: number;
}
