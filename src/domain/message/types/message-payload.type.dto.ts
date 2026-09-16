import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import type { MessagePayload } from '~types';

import { MessageDigestItemType } from './message-digest-item.type.dto';

/**
 * A message's content. Which half is populated follows the message's `kind`.
 *
 * Unlike `QuickFilterType.filters`, this is a nested typed class rather than an
 * opaque leaf, and it can be: the payload is written by this server, never by a
 * client, so every key is known and decorated — which is what keeps the
 * outgoing `whitelist: true` validation from stripping any of it.
 */
export class MessagePayloadType implements MessagePayload {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageDigestItemType)
  public items?: MessageDigestItemType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  public total?: number;

  @IsOptional()
  @IsString()
  public subject?: string;

  @IsOptional()
  @IsString()
  public body?: string;

  @IsOptional()
  @IsString()
  public subjectEn?: string;

  @IsOptional()
  @IsString()
  public bodyEn?: string;

  @IsOptional()
  @IsString()
  public url?: string;
}
