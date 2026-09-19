import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { KbStatus, ProducerKind } from '~enums';
import type { ID, ProducerQueueRow } from '~types';

import { ProducerIssueType } from './producer-issue.type.dto';

/**
 * One producer in the curation queue.
 */
export class ProducerQueueRowType implements ProducerQueueRow {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsEnum(ProducerKind)
  public kind!: ProducerKind;

  @IsEnum(KbStatus)
  public status!: KbStatus;

  @IsOptional()
  @IsString()
  public countryCode!: string | null;

  @IsOptional()
  @IsString()
  public countryName!: string | null;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;

  @IsOptional()
  @IsString()
  public region!: string | null;

  @IsOptional()
  @IsString()
  public defaultTypeName!: string | null;

  @IsString()
  public peatProfile!: string;

  @IsInt()
  public productCount!: number;

  @IsInt()
  public aliasCount!: number;

  /**
   * How many unresolved stocked bottlings name this producer in a raw listing
   * name — the work one alias would clear.
   */
  @IsInt()
  public unresolvedMentions!: number;

  /**
   * How many bottlings would resolve to it if the whole withheld queue went
   * live. Null for a live producer, where `productCount` is already a real
   * answer.
   */
  @IsOptional()
  @IsInt()
  public potentialReach!: number | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProducerIssueType)
  public issues!: ProducerIssueType[];

  @IsDate()
  public createdAt!: Date;
}
