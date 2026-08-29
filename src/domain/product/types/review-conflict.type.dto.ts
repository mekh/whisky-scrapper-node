import { IsDate, IsInt, IsOptional, IsString } from 'class-validator';

import type { ID, ReviewConflictRow } from '~types';

export class ReviewConflictType implements ReviewConflictRow {
  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public productName!: string | null;

  @IsString()
  public storeId!: ID;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public attribute!: string;

  @IsOptional()
  @IsString()
  public storedValue!: string | null;

  @IsOptional()
  @IsString()
  public claimedValue!: string | null;

  @IsOptional()
  @IsString()
  public storedSource!: string | null;

  @IsInt()
  public seenCount!: number;

  @IsDate()
  public lastSeenAt!: Date;
}
