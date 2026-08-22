import { IsNumber, IsOptional, IsString } from 'class-validator';

import type { DashboardMover, ID } from '~types';

export class DashboardMoverType implements DashboardMover {
  @IsString()
  public storeProductId!: ID;

  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsString()
  public nameOrig!: string;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public storeName!: string;

  @IsString()
  public firstDate!: string;

  @IsString()
  public lastDate!: string;

  @IsNumber()
  public firstPrice!: number;

  @IsNumber()
  public lastPrice!: number;

  @IsNumber()
  public changeAbs!: number;

  @IsNumber()
  public changePct!: number;

  @IsString()
  public currency!: string;
}
