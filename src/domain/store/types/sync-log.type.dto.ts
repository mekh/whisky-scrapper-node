import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

import type { EntitySyncLog, ID } from '~types';

export class SyncLogType implements EntitySyncLog {
  @IsString()
  public id!: ID;

  @IsDate()
  @Type(() => Date)
  public createdAt!: Date;

  @IsDate()
  @Type(() => Date)
  public updatedAt!: Date;

  @IsString()
  public storeId!: ID;

  @IsInt()
  public added!: number;

  @IsInt()
  public removed!: number;

  @IsInt()
  public updated!: number;

  @IsInt()
  public total!: number;

  @IsOptional()
  @IsBoolean()
  public success?: boolean;

  @IsOptional()
  @IsString()
  public error?: string;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  public finishedAt?: Date;
}
