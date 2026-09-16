import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { CurrentUser } from '~decorators/auth';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  CtxUser,
  MessageBroadcastPreview,
  MessageBroadcastResult,
} from '~types';

import { MessageBroadcastAudienceDto, MessageBroadcastDto } from './dto';
import { MessageService } from './message.service';
import {
  MessageBroadcastPreviewType,
  MessageBroadcastResultType,
} from './types';

/**
 * Sending a message to other people, which is a different permission from
 * reading one's own inbox — hence its own controller, where every route
 * carries `message:create` and nothing a plain reader can reach is mixed in.
 *
 * There is no admin UI for this yet, by design: the audience rules and the
 * fan-out are what had to exist first, and a screen over them is a separate
 * piece of work that needs no further backend change.
 */
@Controller('message/broadcast')
export class MessageBroadcastController {
  public constructor(private readonly messages: MessageService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Plain(MessageBroadcastPreviewType, [Resource.MESSAGE, Action.CREATE])
  public preview(
    @Body() body: MessageBroadcastAudienceDto,
  ): Promise<MessageBroadcastPreview> {
    return this.messages.previewBroadcast(body);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Plain(MessageBroadcastResultType, [Resource.MESSAGE, Action.CREATE])
  public send(
    @CurrentUser() user: CtxUser,
    @Body() body: MessageBroadcastDto,
  ): Promise<MessageBroadcastResult> {
    return this.messages.broadcast(body, user.id);
  }
}
