import { IsInt, Min } from 'class-validator';

import type { MessageUnreadCount } from '~types';

/**
 * How many messages the caller has not read yet.
 */
export class MessageUnreadCountType implements MessageUnreadCount {
  @IsInt()
  @Min(0)
  public count!: number;
}
