import { IsInt } from 'class-validator';

import type { ReviewBulkResult } from '~types';

export class ReviewBulkResultType implements ReviewBulkResult {
  @IsInt()
  public updated!: number;
}
