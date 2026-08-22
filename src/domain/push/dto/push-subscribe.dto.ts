import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

import { PUSH_ENDPOINT_MAX_LENGTH, PUSH_KEY_MAX_LENGTH } from '~constants';
import type { PushSubscribeInput } from '~types';

/**
 * The flattened form of the browser's `PushSubscription.toJSON()` — flat on
 * purpose, so no nested DTO with `@ValidateNested` is needed. The client maps
 * `{ endpoint, keys: { p256dh, auth } }` to these three fields.
 */
export class PushSubscribeDto implements PushSubscribeInput {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(PUSH_ENDPOINT_MAX_LENGTH)
  public endpoint!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PUSH_KEY_MAX_LENGTH)
  public p256dh!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PUSH_KEY_MAX_LENGTH)
  public auth!: string;
}
