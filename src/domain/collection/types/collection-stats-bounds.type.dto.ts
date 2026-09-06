import { IsString } from 'class-validator';

import type { CollectionStatsBounds } from '~types';

export class CollectionStatsBoundsType implements CollectionStatsBounds {
  @IsString()
  public firstMonth!: string;

  @IsString()
  public lastMonth!: string;
}
