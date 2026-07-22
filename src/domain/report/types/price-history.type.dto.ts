import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';

import { PriceHistory } from '~types';

import { PriceHistoryPointType } from './price-history-point.type.dto';
import { ReportRowType } from './report-row.type.dto';

export class PriceHistoryType implements PriceHistory {
  @ValidateNested()
  @Type(() => ReportRowType)
  public product!: ReportRowType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceHistoryPointType)
  public series!: PriceHistoryPointType[];
}
