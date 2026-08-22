import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { BRAND_NAME_MAX_LENGTH } from '~constants';
import { GuidV7 } from '~decorators/fields';
import type { ID, PreferenceBlacklistInput } from '~types';

/**
 * Upper bound on one blacklist request, per list. Same reasoning as the
 * favorites cap: the UI hides one product at a time, and the limit only stops a
 * malformed request from becoming a huge insert.
 */
const MAX_BLACKLIST_IDS = 100;

/**
 * Both lists are optional here; a request that carries neither is rejected by
 * the service, because the rule spans two fields and this codebase has no
 * custom cross-field validator to follow.
 */
export class PreferenceBlacklistDto implements PreferenceBlacklistInput {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BLACKLIST_IDS)
  @GuidV7({ each: true })
  public productIds?: ID[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BLACKLIST_IDS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(BRAND_NAME_MAX_LENGTH, { each: true })
  public brands?: string[];
}
