import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  ValidateIf,
} from 'class-validator';

import { MESSAGE_BROADCAST_MAX_EXPLICIT_IDS } from '~constants';
import { GuidV7, IsoDate } from '~decorators/fields';
import { AudienceMode } from '~enums';
import type { ID, MessageBroadcastAudience } from '~types';

export class MessageBroadcastAudienceDto implements MessageBroadcastAudience {
  @IsEnum(AudienceMode)
  public audience!: AudienceMode;

  @ValidateIf((dto: MessageBroadcastAudienceDto) =>
    dto.audience === AudienceMode.EXPLICIT_IDS
  )
  @ArrayMinSize(1)
  @ArrayMaxSize(MESSAGE_BROADCAST_MAX_EXPLICIT_IDS)
  @GuidV7({ each: true })
  @Type(() => String)
  public userIds?: ID[];

  @ValidateIf((dto: MessageBroadcastAudienceDto) =>
    dto.audience === AudienceMode.REGISTRATION_DATE
  )
  @IsoDate(true)
  public registeredFrom?: string;

  @ValidateIf((dto: MessageBroadcastAudienceDto) =>
    dto.audience === AudienceMode.REGISTRATION_DATE
  )
  @IsoDate(true)
  public registeredTo?: string;
}
