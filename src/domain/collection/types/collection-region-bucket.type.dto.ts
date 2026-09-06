import { IsInt, IsString } from 'class-validator';

import type { CollectionRegionBucket } from '~types';

export class CollectionRegionBucketType implements CollectionRegionBucket {
  @IsString()
  public region!: string;

  @IsInt()
  public bottles!: number;

  @IsInt()
  public items!: number;
}
