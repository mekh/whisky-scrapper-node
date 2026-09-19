import { IsUUID } from 'class-validator';

import type { ID, ReviewMergeInput } from '~types';

export class ReviewMergeDto implements ReviewMergeInput {
  /**
   * The bottling that vanishes. Its key is retired into an alias, so the next
   * sync cannot recreate it.
   */
  @IsUUID('all')
  public sourceId!: ID;

  @IsUUID('all')
  public targetId!: ID;
}
