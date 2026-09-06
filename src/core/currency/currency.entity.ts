import { IsBoolean, IsInt, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import {
  CURRENCY_MAX_LENGTH,
  CURRENCY_NAME_MAX_LENGTH,
  CURRENCY_SYMBOL_MAX_LENGTH,
} from '~constants';
import type { EntityCurrency } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * A currency prices can be displayed in.
 *
 * This is a lookup table and not a `SELECT DISTINCT code FROM currency_rate`
 * for three reasons, the first of which is this codebase's own rule that
 * filter and picker options come from the database rather than a hardcoded
 * list: a derived list could not express the base currency, which by
 * definition has no rate rows; it would have nowhere to carry the Ukrainian
 * name and the symbol a client renders; and it could not mark a currency as
 * present-but-not-offered, which is what `active` is for.
 *
 * `country` is the precedent — a `code`/`nameUa` lookup with a unique index on
 * the code — and that unique index is also what lets `currency_rate` reference
 * the code directly.
 */
@Entity('currency')
export class CurrencyEntity extends BaseRichEntity implements EntityCurrency {
  @IsString()
  @MaxLength(CURRENCY_MAX_LENGTH)
  @Column({ length: CURRENCY_MAX_LENGTH })
  @Index('currency_code_uindex', { unique: true })
  public code!: string;

  @IsInt()
  @Column({ type: 'int' })
  public numericCode!: number;

  @IsString()
  @MaxLength(CURRENCY_NAME_MAX_LENGTH)
  @Column({ length: CURRENCY_NAME_MAX_LENGTH })
  public nameUa!: string;

  @IsString()
  @MaxLength(CURRENCY_SYMBOL_MAX_LENGTH)
  @Column({ length: CURRENCY_SYMBOL_MAX_LENGTH })
  public symbol!: string;

  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  public isBase!: boolean;

  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  public active!: boolean;
}
