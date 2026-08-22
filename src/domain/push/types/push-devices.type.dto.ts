import { Type } from 'class-transformer';
import { IsArray, IsInt, Min, ValidateNested } from 'class-validator';

import type { PushDevices } from '~types';

import { PushDeviceType } from './push-device.type.dto';

export class PushDevicesType implements PushDevices {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PushDeviceType)
  public devices!: PushDeviceType[];

  @IsInt()
  @Min(0)
  public total!: number;
}
