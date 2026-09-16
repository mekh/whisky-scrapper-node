import { IsInt, Min } from 'class-validator';

import type { MessageBroadcastPreview } from '~types';

/**
 * How many people an audience resolves to, without sending anything.
 */
export class MessageBroadcastPreviewType implements MessageBroadcastPreview {
  @IsInt()
  @Min(0)
  public recipients!: number;
}
