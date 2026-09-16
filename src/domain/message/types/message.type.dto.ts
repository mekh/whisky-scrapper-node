import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { MessageKind } from '~enums';
import type { ID, Message } from '~types';

import { MessagePayloadType } from './message-payload.type.dto';

/**
 * One inbox message as the API returns it, already joined to the caller's own
 * read state. Named `MessageType` because the plain name belongs to the
 * `~types` interface.
 */
export class MessageType implements Message {
  @IsString()
  public id!: ID;

  @IsEnum(MessageKind)
  public kind!: MessageKind;

  @ValidateNested()
  @Type(() => MessagePayloadType)
  public payload!: MessagePayloadType;

  @IsOptional()
  @IsDate()
  public readAt!: Date | null;

  @IsDate()
  public createdAt!: Date;
}
