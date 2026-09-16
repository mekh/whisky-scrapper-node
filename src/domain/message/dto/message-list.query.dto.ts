import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { MESSAGE_MAX_PAGE_LIMIT } from '~constants';
import type { MessageListQuery } from '~types';

export class MessageListQueryDto implements MessageListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MESSAGE_MAX_PAGE_LIMIT)
  public limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  public offset?: number;
}
