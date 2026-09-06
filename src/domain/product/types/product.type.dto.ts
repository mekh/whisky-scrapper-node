import { IsBoolean, IsOptional, IsString } from 'class-validator';

import type { ID, TypeProduct } from '~types';

export class ProductType implements TypeProduct {
  @IsString()
  public id!: ID;

  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsString()
  public nameOrig!: string;

  @IsBoolean()
  public merged!: boolean;

  @IsBoolean()
  public created!: boolean;
}
