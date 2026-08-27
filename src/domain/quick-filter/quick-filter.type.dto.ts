import { IsDate, IsString, MaxLength } from 'class-validator';

import { QUICK_FILTER_NAME_MAX_LENGTH } from '~constants';
import { FilterPayload } from '~decorators/fields';
import type { ID, QuickFilter, QuickFilterPayload } from '~types';

/**
 * One saved filter set as the API returns it. Named `QuickFilterType` because
 * the plain name belongs to the `~types` interface.
 *
 * `filters` must stay a leaf field here, not a nested typed class: the outgoing
 * `ValidationInterceptor` validates this instance with `whitelist: true`, which
 * would strip every key of a nested payload class — including the ones a newer
 * client just saved.
 */
export class QuickFilterType implements QuickFilter {
  @IsString()
  public id!: ID;

  @IsString()
  @MaxLength(QUICK_FILTER_NAME_MAX_LENGTH)
  public name!: string;

  @FilterPayload()
  public filters!: QuickFilterPayload;

  @IsDate()
  public createdAt!: Date;

  @IsDate()
  public updatedAt!: Date;
}
