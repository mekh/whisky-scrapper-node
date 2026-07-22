import { IsOptional, IsString } from 'class-validator';

import type { ID, TypeProduct } from '~types';

export class ProductType implements TypeProduct {
  @IsString()
  public id!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsString()
  public nameOrig!: string;
}
