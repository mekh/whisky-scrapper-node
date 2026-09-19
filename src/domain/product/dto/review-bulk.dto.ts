import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import { REVIEW_BULK_MAX } from '~constants';
import type { ID, ReviewBulkInput } from '~types';

export class ReviewBulkDto implements ReviewBulkInput {
  /**
   * The bottlings to write. Bounded by the screen's own page size, and it is
   * a bound on the request rather than a nicety: the statements are applied
   * one at a time inside one transaction.
   */
  @ArrayNotEmpty()
  @ArrayMaxSize(REVIEW_BULK_MAX)
  @IsUUID('all', { each: true })
  public productIds!: ID[];

  @IsOptional()
  @IsString()
  public typeName?: string;

  @IsOptional()
  @IsString()
  public countryCode?: string;

  @IsOptional()
  @IsUUID('all')
  public producerId?: ID;
}
