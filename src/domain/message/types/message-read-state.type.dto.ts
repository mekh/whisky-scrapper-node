import { IsDate, IsOptional, IsString } from 'class-validator';

import type { ID, MessageReadState } from '~types';

import { MessageUnreadCountType } from './message-unread-count.type.dto';

/**
 * The result of changing one message's read state. It carries the new unread
 * count so the badge needs no second request.
 */
export class MessageReadStateType extends MessageUnreadCountType
  implements MessageReadState {
  @IsString()
  public id!: ID;

  @IsOptional()
  @IsDate()
  public readAt!: Date | null;
}
