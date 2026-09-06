import { CsvArray, IsoDate } from '~decorators/fields';

/**
 * `GET /currency/rate` — the rates of several currencies on one day.
 */
export class CurrencyRateQueryDto {
  @CsvArray()
  public codes?: string[];

  @IsoDate(true)
  public date?: string;
}
