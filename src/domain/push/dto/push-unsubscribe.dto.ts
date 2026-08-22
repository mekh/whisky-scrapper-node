import { IsUrl, MaxLength } from 'class-validator';

import { PUSH_ENDPOINT_MAX_LENGTH } from '~constants';
import type { PushUnsubscribeInput } from '~types';

export class PushUnsubscribeDto implements PushUnsubscribeInput {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(PUSH_ENDPOINT_MAX_LENGTH)
  public endpoint!: string;
}
