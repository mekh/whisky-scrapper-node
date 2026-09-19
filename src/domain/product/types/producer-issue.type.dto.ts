import { IsEnum } from 'class-validator';

import { ProducerIssueCode, ReviewIssueSeverity } from '~enums';
import type { ProducerIssue } from '~types';

/**
 * One reason a producer is in the queue.
 *
 * Its own class rather than a reuse of {@link ReviewIssueType}: the two queues
 * share the severity vocabulary and nothing else.
 */
export class ProducerIssueType implements ProducerIssue {
  @IsEnum(ProducerIssueCode)
  public code!: ProducerIssueCode;

  @IsEnum(ReviewIssueSeverity)
  public severity!: ReviewIssueSeverity;
}
