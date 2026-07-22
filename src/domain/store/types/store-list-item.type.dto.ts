import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';

import type { ID, StoreListItem } from '~types';

export class StoreListItemType implements StoreListItem {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsString()
  public baseUrl!: string;

  @IsOptional()
  @IsString()
  public color!: string | null;

  @IsBoolean()
  public active!: boolean;

  @IsOptional()
  @IsInt()
  public tier!: number | null;

  @IsOptional()
  @IsBoolean()
  public needsBrowser!: boolean | null;

  @IsOptional()
  @IsString()
  public retailChain!: string | null;

  @IsOptional()
  @IsString()
  public category!: string | null;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  public lastSuccessfulSyncAt!: Date | null;
}
