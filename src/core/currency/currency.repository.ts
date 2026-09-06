import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { CurrencyEntity } from './currency.entity';

@TypeormRepository(CurrencyEntity)
export class CurrencyRepository extends BaseRepository<CurrencyEntity> {
  /**
   * Reads the currencies on offer, base first and then alphabetically — the
   * order a picker renders them in, decided here so every client agrees.
   *
   * @returns The active currencies.
   */
  public async findActive(): Promise<CurrencyEntity[]> {
    return this.find({
      where: { active: true },
      order: { isBase: 'DESC', code: 'ASC' },
    });
  }

  /**
   * Reads every currency, active or not — an inactive one must still convert
   * the records that were priced in it.
   *
   * The whole table is three rows, so there is no pagination to respect here.
   *
   * @returns Every currency, base first then alphabetically.
   */
  public async findAll(): Promise<CurrencyEntity[]> {
    return this.find({ order: { isBase: 'DESC', code: 'ASC' } });
  }

  /**
   * Reads currencies by code, whether or not they are active. Inactive rows
   * are included on purpose: a record priced in a currency that was later
   * withdrawn must still convert.
   *
   * @param codes - Codes to read, case-insensitive.
   * @returns The matching currencies, in no particular order.
   */
  public async findByCodes(codes: string[]): Promise<CurrencyEntity[]> {
    const wanted = [
      ...new Set(
        codes.map((code) => code.trim().toUpperCase()).filter(Boolean),
      ),
    ];

    if (!wanted.length) {
      return [];
    }

    return this.createQueryBuilder('c')
      .where('c.code = ANY(:codes)', { codes: wanted })
      .getMany();
  }
}
