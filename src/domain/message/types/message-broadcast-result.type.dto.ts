import { IsOptional, IsString } from 'class-validator';

import type { ID, MessageBroadcastResult } from '~types';

import {
  MessageBroadcastPreviewType,
} from './message-broadcast-preview.type.dto';

/**
 * What a sent broadcast did: the message it created and how many inboxes it
 * reached.
 */
export class MessageBroadcastResultType extends MessageBroadcastPreviewType
  implements MessageBroadcastResult {
  @IsOptional()
  @IsString()
  public messageId!: ID | null;
}
