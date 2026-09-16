import { IntersectionType } from '@nestjs/mapped-types';

import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_SUBJECT_MAX_LENGTH,
  MESSAGE_URL_MAX_LENGTH,
} from '~constants';
import { SafeText } from '~decorators/fields';
import type { MessageBroadcastContent, MessageBroadcastInput } from '~types';

import { MessageBroadcastAudienceDto } from './message-broadcast-audience.dto';

/**
 * The authored half of a broadcast. Split from the audience so the audience
 * can be validated on its own by the preview route — and so the two routes
 * cannot drift into validating the recipients differently.
 */
class MessageBroadcastContentDto implements MessageBroadcastContent {
  @SafeText({ max: MESSAGE_SUBJECT_MAX_LENGTH, notEmpty: true })
  public subject!: string;

  @SafeText({ max: MESSAGE_BODY_MAX_LENGTH, multiline: true, notEmpty: true })
  public body!: string;

  @SafeText({ max: MESSAGE_SUBJECT_MAX_LENGTH, optional: true })
  public subjectEn?: string;

  @SafeText({
    max: MESSAGE_BODY_MAX_LENGTH,
    multiline: true,
    optional: true,
  })
  public bodyEn?: string;

  @SafeText({ max: MESSAGE_URL_MAX_LENGTH, optional: true })
  public url?: string;
}

export class MessageBroadcastDto extends IntersectionType(
  MessageBroadcastAudienceDto,
  MessageBroadcastContentDto,
) implements MessageBroadcastInput {}
