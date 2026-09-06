import { IsOptional, IsString } from 'class-validator';

import type { CollectionPurchaseStore } from '~types';

export class CollectionPurchaseStoreType implements CollectionPurchaseStore {
  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsOptional()
  @IsString()
  public color!: string | null;
}
