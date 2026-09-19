import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString } from 'class-validator';

import type { ID, ReviewConflict } from '~types';

export class ReviewConflictType implements ReviewConflict {
  @IsString()
  public storeId!: ID;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public attribute!: string;

  @IsString()
  public claimed!: string;

  @IsString()
  public stored!: string;

  @IsOptional()
  @IsString()
  public storedSource!: string | null;

  @IsInt()
  public seenCount!: number;

  /**
   * When it last did.
   *
   * `@Type` because these rows are aggregated with `json_build_object`, which
   * renders a timestamp as an ISO string rather than handing back the `Date`
   * a plain column select would.
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  public lastSeenAt!: Date | null;

  /**
   * When somebody acknowledged it. A re-sighting no longer clears this, so an
   * acknowledged contradiction stays acknowledged.
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  public resolvedAt!: Date | null;
}
