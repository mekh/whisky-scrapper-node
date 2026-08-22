import { ArrayMaxSize, IsArray } from 'class-validator';

import { GuidV7 } from '~decorators/fields';
import type { ID, PreferenceFavoritesInput } from '~types';

/**
 * Upper bound on one favorites request. The UI toggles a single product at a
 * time, so this only exists to keep a malformed request from turning into a
 * huge insert.
 */
const MAX_FAVORITE_IDS = 100;

export class PreferenceFavoritesDto implements PreferenceFavoritesInput {
  @IsArray()
  @ArrayMaxSize(MAX_FAVORITE_IDS)
  @GuidV7({ each: true })
  public productIds!: ID[];
}
