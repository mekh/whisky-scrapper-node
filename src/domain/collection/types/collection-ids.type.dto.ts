import { IsArray, IsString } from 'class-validator';

import type { CollectionIds, ID } from '~types';

export class CollectionIdsType implements CollectionIds {
  @IsArray()
  @IsString({ each: true })
  public productIds!: ID[];
}
