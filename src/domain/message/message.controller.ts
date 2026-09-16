import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';

import { CurrentUser, Permission } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Paginated, Plain } from '~decorators/types';
import { ByIdDto } from '~domain/common/dto';
import { Resource } from '~enums';
import type {
  CtxUser,
  Message,
  MessageReadState,
  MessageUnreadCount,
  Response,
  TypePaginated,
} from '~types';

import { MessageListQueryDto, MessageReadDto } from './dto';
import { MessageStreamService } from './message-stream.service';
import { MessageService } from './message.service';
import {
  MessageReadStateType,
  MessageType,
  MessageUnreadCountType,
} from './types';

/**
 * The inbox is per-user and changes with every click in it, so every route
 * here is `no-cache`: a `max-age` would let the browser serve a pre-mutation
 * page minutes after the user cleared it.
 *
 * `unread-count`, `read-all` and `stream` are declared above the `:id` routes.
 * Routes match in declaration order, so a literal path must win over the
 * parameter that would otherwise swallow it — the `StoreController`
 * discipline.
 */
@Controller('message')
export class MessageController {
  public constructor(
    private readonly messages: MessageService,
    private readonly streams: MessageStreamService,
  ) {}

  @Get('unread-count')
  @CacheControl('no-cache')
  @Plain(MessageUnreadCountType, Resource.AUTHENTICATED)
  public unreadCount(
    @CurrentUser() user: CtxUser,
  ): Promise<MessageUnreadCount> {
    return this.messages.unreadCount(user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @Plain(MessageUnreadCountType, Resource.AUTHENTICATED)
  public readAll(
    @CurrentUser() user: CtxUser,
  ): Promise<MessageUnreadCount> {
    return this.messages.markAllRead(user.id);
  }

  @Get('stream')
  @Permission(Resource.AUTHENTICATED)
  public stream(
    @CurrentUser() user: CtxUser,
    @Res() reply: Response,
  ): void {
    this.streams.open(user.id, reply);
  }

  @Get()
  @CacheControl('no-cache')
  @Paginated(MessageType, Resource.AUTHENTICATED)
  public list(
    @CurrentUser() user: CtxUser,
    @Query() query: MessageListQueryDto,
  ): Promise<TypePaginated<Message>> {
    return this.messages.list(user.id, query);
  }

  @Patch(':id/read')
  @Plain(MessageReadStateType, Resource.AUTHENTICATED)
  public setRead(
    @CurrentUser() user: CtxUser,
    @Param() params: ByIdDto,
    @Body() body: MessageReadDto,
  ): Promise<MessageReadState> {
    return this.messages.setRead(user.id, params.id, body.read);
  }
}
