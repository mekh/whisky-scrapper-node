import { IsEnum } from 'class-validator';

import { ReportKind } from '~enums';
import { ReportKindParams } from '~types';

export class ReportKindParamsDto implements ReportKindParams {
  @IsEnum(ReportKind)
  public kind!: ReportKind;
}
