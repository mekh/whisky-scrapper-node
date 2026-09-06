import { IsDateString, IsNumber } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { RATE_PRECISION, RATE_SCALE } from '~constants';
import { GuidV7Column, NumericColumn } from '~decorators/columns';
import type { EntityCurrency, EntityCurrencyRate, ID } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * The NBU's official rate of one currency on one calendar day.
 *
 * One row per `(currencyId, effectiveOn)`, enforced by the unique index below
 * — the same shape `price_snapshot` uses for "one row per offer per day". That
 * index is what makes the sync a single `INSERT ... ON CONFLICT DO UPDATE`, so
 * the script, the cron and the manual endpoint may all run any number of times
 * a day, concurrently, with the last write simply winning. There is
 * deliberately no day-lock and no "already synced today" guard: unlike a
 * scrape, this costs one small request and is perfectly idempotent.
 *
 * The series is **gap-free by construction**: the source publishes every
 * calendar day (weekends and holidays repeat the preceding business day's
 * value), and the few days its own first years are missing are filled on
 * ingest by carrying the last known rate forward — see
 * `CurrencyUtils.fillGaps`. So a lookup never interpolates and never has to
 * reason about holes.
 */
@Entity('currency_rate')
@Index(
  'currency_rate_currency_effective_uindex',
  ['currencyId', 'effectiveOn'],
  { unique: true },
)
export class CurrencyRateEntity extends BaseRichEntity
  implements EntityCurrencyRate {
  @GuidV7Column()
  public currencyId!: ID;

  /**
   * Hryvnia per **one** unit of the currency: `UAH -> currency` divides by it,
   * `currency -> UAH` multiplies by it.
   *
   * `NumericColumn`'s default precision is the shared `numeric(12,2)` of a
   * price, which would truncate this — a normalized rate carries up to six
   * decimals across the hryvnia's high-inflation years — so the scale is
   * overridden here rather than inherited.
   */
  @IsNumber()
  @NumericColumn({ precision: RATE_PRECISION, scale: RATE_SCALE })
  public rate!: number;

  @IsDateString()
  @Column({ type: 'date' })
  public effectiveOn!: string;

  @ManyToOne(
    'CurrencyEntity',
    (currency: EntityCurrency) => currency.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_currency_rate_currency',
    name: 'currencyId',
  })
  public currency!: EntityCurrency;
}
