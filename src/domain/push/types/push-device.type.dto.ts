import { IsDate, IsOptional, IsString } from 'class-validator';

import type { ID, PushDevice } from '~types';

/**
 * One subscribed browser as the settings screen lists it. Deliberately
 * without key material — `p256dh`/`auth` never leave the persistence layer.
 */
export class PushDeviceType implements PushDevice {
  @IsString()
  public id!: ID;

  @IsString()
  @IsOptional()
  public userAgent!: string | null;

  @IsDate()
  public createdAt!: Date;

  @IsDate()
  @IsOptional()
  public lastSuccessAt!: Date | null;
}
