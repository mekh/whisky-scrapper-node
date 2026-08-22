import { IsArray, IsString } from 'class-validator';

import type { ID, Preference } from '~types';

/**
 * Named `PreferenceType` because the plain name belongs to the `~types`
 * interface it implements. Every field carries element validators: the outgoing
 * `ValidationInterceptor` runs on this instance, and a bare `@IsArray()` would
 * let a non-string element through.
 */
export class PreferenceType implements Preference {
  @IsArray()
  @IsString({ each: true })
  public favorites!: ID[];

  @IsArray()
  @IsString({ each: true })
  public blacklistProducts!: ID[];

  @IsArray()
  @IsString({ each: true })
  public blacklistBrands!: string[];
}
