import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';

import type { ProducerDetail } from '~types';

import { ProducerChildType } from './producer-child.type.dto';
import { ProducerReviewType } from './producer-review.type.dto';
import { ProducerRuleType } from './producer-rule.type.dto';

export class ProducerDetailType implements ProducerDetail {
  @ValidateNested()
  @Type(() => ProducerReviewType)
  public producer!: ProducerReviewType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProducerChildType)
  public children!: ProducerChildType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProducerRuleType)
  public rules!: ProducerRuleType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProducerRuleType)
  public globalPeatRules!: ProducerRuleType[];
}
