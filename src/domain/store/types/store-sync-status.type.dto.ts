import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString } from 'class-validator';

import type { ID, StoreSyncStatus } from '~types';

export class StoreSyncStatusType implements StoreSyncStatus {
  @IsString()
  public storeId!: ID;

  @IsString()
  public storeSlug!: string;

  @IsOptional()
  @IsString()
  public group!: string | null;

  @IsDate()
  @Type(() => Date)
  public startedAt!: Date;

  @IsInt()
  public total!: number;
}
