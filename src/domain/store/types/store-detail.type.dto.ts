import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsInt,
  IsOptional,
  ValidateNested,
} from 'class-validator';

import type { StoreDetail } from '~types';

import { StoreListItemType } from './store-list-item.type.dto';
import { SyncLogType } from './sync-log.type.dto';

export class StoreDetailType extends StoreListItemType implements StoreDetail {
  @IsDate()
  @Type(() => Date)
  public createdAt!: Date;

  @IsInt()
  public productCount!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SyncLogType)
  public lastSync!: SyncLogType | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncLogType)
  public recentSyncs!: SyncLogType[];
}
