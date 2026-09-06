import { CurrencyRateSyncRequest } from '~types';

import { CsvArray, IsoDate } from '~decorators/fields';

/**
 * `POST /currency/rate/sync` — run the rate sync by hand.
 *
 * Every field is optional: an empty body performs exactly the routine the
 * daily job performs.
 */
export class CurrencyRateSyncDto implements CurrencyRateSyncRequest {
  @CsvArray()
  public codes?: string[];

  @IsoDate(true)
  public from?: string;

  @IsoDate(true)
  public to?: string;
}
