import { CsvArray, IsoDate } from '~decorators/fields';
import { DashboardRangeQuery } from '~types';

export class DashboardRangeQueryDto implements DashboardRangeQuery {
  @IsoDate()
  public from!: string;

  @IsoDate()
  public to!: string;

  @CsvArray()
  public stores?: string[];
}
