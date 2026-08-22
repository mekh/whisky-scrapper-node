import { IsString } from 'class-validator';

import type { TypeBrand } from '~types';

/**
 * Named `BrandType` because the plain name belongs to the persistence entity
 * (`BrandEntity` is exposed as `brand`), and `TypeBrand` to the `~types`
 * interface it implements.
 */
export class BrandType implements TypeBrand {
  @IsString()
  public name!: string;
}
