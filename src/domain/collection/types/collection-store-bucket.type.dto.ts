import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

import type { CollectionStoreBucket } from '~types';

export class CollectionStoreBucketType implements CollectionStoreBucket {
  @IsOptional()
  @IsString()
  public slug!: string | null;

  @IsString()
  public name!: string;

  @IsOptional()
  @IsString()
  public color!: string | null;

  @IsInt()
  public bottles!: number;

  @IsNumber()
  public spent!: number;
}
