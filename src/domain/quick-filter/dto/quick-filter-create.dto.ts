import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { QUICK_FILTER_NAME_MAX_LENGTH } from '~constants';
import { FilterPayload } from '~decorators/fields';
import type { QuickFilterCreateInput, QuickFilterPayload } from '~types';

export class QuickFilterCreateDto implements QuickFilterCreateInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(QUICK_FILTER_NAME_MAX_LENGTH)
  public name!: string;

  @FilterPayload()
  public filters!: QuickFilterPayload;
}
