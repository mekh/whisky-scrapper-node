import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreBrandService } from '~core/brand';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const TOKEN = `itbs${STAMP}`;

const PREFIXED = `${TOKEN} Alpha`;

const PREFIXED_LONGER = `${TOKEN} Beta Longer`;

const INFIX = `Old ${TOKEN} House`;

/**
 * The brand autocomplete (`BrandRepository.searchByName`) against the live
 * database: substring matching, prefix-before-infix ordering, and the limit.
 */
describe('brand autocomplete search (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let brands: CoreBrandService;
  let brandIds: ID[];

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    brands = moduleRef.get(CoreBrandService, { strict: false });

    const resolved = await brands.resolveByName([
      PREFIXED,
      PREFIXED_LONGER,
      INFIX,
    ]);

    brandIds = [...resolved.values()];
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM brand WHERE id = ANY($1::uuid[])',
        [brandIds],
      );

      await closeIntegrationModule(moduleRef);
    }
  });

  it('matches the term anywhere in the name', async () => {
    const rows = await brands.searchByName(TOKEN, 10);

    expect(rows.map((row) => row.name).sort()).toEqual(
      [PREFIXED, PREFIXED_LONGER, INFIX].sort(),
    );
  });

  it('ranks prefix matches first, shortest name breaking ties', async () => {
    const rows = await brands.searchByName(TOKEN, 10);

    expect(rows.map((row) => row.name))
      .toEqual([PREFIXED, PREFIXED_LONGER, INFIX]);
  });

  it('honours the limit', async () => {
    const rows = await brands.searchByName(TOKEN, 2);

    expect(rows).toHaveLength(2);
  });
});
