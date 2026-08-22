import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';

import type { PreferenceDetails } from '~types';

import { PreferenceBrandType } from './preference-brand.type.dto';
import { PreferenceProductType } from './preference-product.type.dto';

/**
 * The settings screen's read: every list entry resolved to a renderable item,
 * newest first. `GET /preference` stays the id-set read the report rows use.
 */
export class PreferenceDetailsType implements PreferenceDetails {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceProductType)
  public favorites!: PreferenceProductType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceProductType)
  public blacklistProducts!: PreferenceProductType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceBrandType)
  public blacklistBrands!: PreferenceBrandType[];
}
