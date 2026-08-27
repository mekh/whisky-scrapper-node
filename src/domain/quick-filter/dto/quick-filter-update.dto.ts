import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

import { QUICK_FILTER_NAME_MAX_LENGTH } from '~constants';
import { FilterPayload } from '~decorators/fields';
import type { QuickFilterPayload, QuickFilterUpdateInput } from '~types';

/**
 * Both fields are independently optional, and the global pipe's
 * `exposeUnsetFields: false` makes an omitted one genuinely absent rather than
 * an explicit `undefined`. That is what makes a rename payload-safe: a client
 * that cannot parse a newer filter dimension renames the set without ever
 * sending — and therefore without overwriting — its `filters`.
 */
export class QuickFilterUpdateDto implements QuickFilterUpdateInput {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(QUICK_FILTER_NAME_MAX_LENGTH)
  public name?: string;

  @IsOptional()
  @FilterPayload()
  public filters?: QuickFilterPayload;
}
