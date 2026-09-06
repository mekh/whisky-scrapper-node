import { IsInt, IsNumber, IsString } from 'class-validator';

import type { CollectionTimelineBucket } from '~types';

export class CollectionTimelineBucketType implements CollectionTimelineBucket {
  @IsString()
  public period!: string;

  @IsInt()
  public bottles!: number;

  @IsNumber()
  public spent!: number;
}
