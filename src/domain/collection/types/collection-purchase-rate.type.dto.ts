import { IsNumber, IsOptional, IsString } from 'class-validator';

import type { CollectionPurchaseRate } from '~types';

export class CollectionPurchaseRateType implements CollectionPurchaseRate {
  @IsString()
  public code!: string;

  @IsOptional()
  @IsNumber()
  public rate!: number | null;

  @IsOptional()
  @IsString()
  public effectiveOn!: string | null;
}
