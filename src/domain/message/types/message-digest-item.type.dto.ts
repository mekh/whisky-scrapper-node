import { IsInt, IsNumber, IsString, Min } from 'class-validator';

import type { ID, MessageDigestItem } from '~types';

/**
 * One dropped bottling inside a discount digest, as the API returns it.
 */
export class MessageDigestItemType implements MessageDigestItem {
  @IsString()
  public productId!: ID;

  @IsString()
  public name!: string;

  @IsNumber()
  public discountPct!: number;

  @IsNumber()
  public price!: number;

  @IsNumber()
  public previousPrice!: number;

  @IsString()
  public currency!: string;

  @IsString()
  public storeName!: string;

  @IsInt()
  @Min(1)
  public storeCount!: number;
}
