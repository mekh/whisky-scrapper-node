import { IsEnum, IsOptional, IsString } from 'class-validator';

import { ReviewIssueCode, ReviewIssueSeverity } from '~enums';
import type { ReviewIssue } from '~types';

export class ReviewIssueType implements ReviewIssue {
  @IsEnum(ReviewIssueCode)
  public code!: ReviewIssueCode;

  @IsEnum(ReviewIssueSeverity)
  public severity!: ReviewIssueSeverity;

  @IsOptional()
  @IsString()
  public field?: string;

  @IsOptional()
  @IsString()
  public detail?: string;
}
