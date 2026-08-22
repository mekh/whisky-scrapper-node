import { IsInt, Min } from 'class-validator';

import { IsoDate } from '~decorators/fields';
import type { PushDispatchReport } from '~types';

export class PushDispatchReportType implements PushDispatchReport {
  @IsoDate()
  public capturedOn!: string;

  @IsInt()
  @Min(0)
  public users!: number;

  @IsInt()
  @Min(0)
  public items!: number;

  @IsInt()
  @Min(0)
  public sent!: number;

  @IsInt()
  @Min(0)
  public gone!: number;

  @IsInt()
  @Min(0)
  public failed!: number;
}
