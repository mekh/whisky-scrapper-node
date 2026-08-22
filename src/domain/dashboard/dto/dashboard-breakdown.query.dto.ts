import { IsEnum } from 'class-validator';

import { CsvArray, IsoDate } from '~decorators/fields';
import { DashboardBreakdownBy } from '~enums';
import { DashboardBreakdownQuery } from '~types';

export class DashboardBreakdownQueryDto implements DashboardBreakdownQuery {
  @IsEnum(DashboardBreakdownBy)
  public by!: DashboardBreakdownBy;

  @IsoDate(true)
  public date?: string;

  @CsvArray()
  public stores?: string[];
}
