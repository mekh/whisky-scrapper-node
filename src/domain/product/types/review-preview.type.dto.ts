import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { ProductReviewStatus } from '~enums';
import type {
  ID,
  ReviewAffected,
  ReviewAffectedChanges,
  ReviewAliasScopeReach,
  ReviewCommitResult,
  ReviewFactChange,
  ReviewPreview,
} from '~types';

/**
 * One fact an action would change.
 */
export class ReviewFactChangeType implements ReviewFactChange {
  @IsOptional()
  @IsString()
  public from!: string | null;

  @IsOptional()
  @IsString()
  public to!: string | null;
}

/**
 * The three facts a producer action can move.
 */
export class ReviewAffectedChangesType implements ReviewAffectedChanges {
  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewFactChangeType)
  public producer?: ReviewFactChangeType;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewFactChangeType)
  public type?: ReviewFactChangeType;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewFactChangeType)
  public country?: ReviewFactChangeType;
}

/**
 * One bottling an action would touch beyond the one being edited.
 */
export class ReviewAffectedType implements ReviewAffected {
  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsInt()
  public volumeMl!: number | null;

  @IsOptional()
  @IsInt()
  public age!: number | null;

  @IsArray()
  @IsString({ each: true })
  public stores!: string[];

  @IsBoolean()
  public inQueue!: boolean;

  @IsOptional()
  @IsEnum(ProductReviewStatus)
  public reviewStatus!: ProductReviewStatus | null;

  @ValidateNested()
  @Type(() => ReviewAffectedChangesType)
  public changes!: ReviewAffectedChangesType;
}

/**
 * What one alias scope would do to the catalogue.
 */
export class ReviewAliasScopeReachType implements ReviewAliasScopeReach {
  /**
   * Bottlings that resolve to nothing today and would leave the queue.
   */
  @IsInt()
  public frees!: number;

  /**
   * Bottlings that resolve to a different producer today and would be
   * re-pointed. The danger number.
   */
  @IsInt()
  public steals!: number;
}

/**
 * What an action would do before it is taken.
 */
@ApiExtraModels(ReviewAliasScopeReachType)
export class ReviewPreviewType implements ReviewPreview {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewAffectedType)
  public affected!: ReviewAffectedType[];

  @IsInt()
  public affectedTotal!: number;

  @ValidateNested()
  @Type(() => ReviewAliasScopeReachType)
  public reach!: ReviewAliasScopeReachType;

  /**
   * The same two numbers per scope, so the narrowest option that fixes the
   * queue is visible before it is chosen.
   *
   * The schema is stated by hand for the one reason `FilterPayload`'s is: the
   * Swagger CLI plugin cannot infer the value type of an index signature, and
   * the generated client would otherwise type each scope `unknown` — which is
   * the binding block's two numbers, unreadable.
   */
  @ApiProperty({
    required: false,
    additionalProperties: { $ref: getSchemaPath(ReviewAliasScopeReachType) },
  })
  @IsOptional()
  @IsObject()
  public aliasScopes?: Record<string, ReviewAliasScopeReachType>;
}

/**
 * What a commit did.
 */
export class ReviewCommitResultType implements ReviewCommitResult {
  @IsString()
  public productId!: ID;

  @IsBoolean()
  public merged!: boolean;

  @IsBoolean()
  public created!: boolean;

  /**
   * Which detectors still fire on the survivor, so the client can say whether
   * the work is finished.
   */
  @IsArray()
  @IsString({ each: true })
  public issuesLeft!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewAffectedType)
  public affected!: ReviewAffectedType[];

  @IsInt()
  public affectedTotal!: number;
}
