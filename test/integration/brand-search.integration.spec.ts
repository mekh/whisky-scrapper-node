import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreProducerService } from '~core/producer';
import { KbStatus, ProducerAliasScope, ProducerKind } from '~enums';
import type { ID } from '~types';
import { KbKeyUtils } from '~utils';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const TOKEN = `itbs${STAMP}`;

const PREFIXED = `${TOKEN} Alpha`;

const PREFIXED_LONGER = `${TOKEN} Beta Longer`;

const INFIX = `Old ${TOKEN} House`;

const ALIASED = `${TOKEN} Aliased`;

const ALIAS_SPELLING = `Isle of ${TOKEN}`;

/**
 * The brand autocomplete against the live database. It reads `producer` now,
 * not the retired `brand` table, so besides the ordering and the limit this
 * pins the thing that changed: a spelling nobody would guess still finds the
 * maker, because every spelling the catalogue ever carried is a row of
 * `producer_alias`.
 */
describe('brand autocomplete search (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let producers: CoreProducerService;
  let slugs: string[];

  /**
   * Seeds one live producer and, optionally, an extra spelling of it.
   *
   * @param name - The producer's display name.
   * @param alias - A further spelling that must reach it, if any.
   * @returns The producer's slug.
   */
  const seed = async (name: string, alias?: string): Promise<string> => {
    const slug = KbKeyUtils.key(name).replace(/ /g, '-');

    const rows = await dataSource.query(
      `INSERT INTO producer (slug, name, kind, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [slug, name, ProducerKind.DISTILLERY, KbStatus.AUTO],
    ) as { id: ID }[];

    const keys = [name, ...(alias === undefined ? [] : [alias])];

    for (const key of keys) {
      await dataSource.query(
        `INSERT INTO producer_alias (key, "producerId", scope)
         VALUES ($1, $2, $3)`,
        [KbKeyUtils.key(key), rows[0].id, ProducerAliasScope.ANY],
      );
    }

    return slug;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    producers = moduleRef.get(CoreProducerService, { strict: false });

    slugs = [
      await seed(PREFIXED),
      await seed(PREFIXED_LONGER),
      await seed(INFIX),
      await seed(ALIASED, ALIAS_SPELLING),
    ];
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM producer WHERE slug = ANY($1::text[])',
        [slugs],
      );

      await closeIntegrationModule(moduleRef);
    }
  });

  it('matches the term anywhere in the name', async () => {
    const rows = await producers.searchByName(TOKEN, 10);

    expect(rows.map((row) => row.name).sort()).toEqual(
      [PREFIXED, PREFIXED_LONGER, INFIX, ALIASED].sort(),
    );
  });

  it('ranks prefix matches first, shortest name breaking ties', async () => {
    const rows = await producers.searchByName(TOKEN, 10);

    expect(rows.map((row) => row.name))
      .toEqual([PREFIXED, ALIASED, PREFIXED_LONGER, INFIX]);
  });

  it('honours the limit', async () => {
    const rows = await producers.searchByName(TOKEN, 2);

    expect(rows).toHaveLength(2);
  });

  /**
   * What the retirement of the `brand` table buys the picker. `Isle of Jura`
   * used to be a `brand` row of its own, so hiding it hid nothing that was
   * filed under `Jura`; typing the long spelling now offers the one producer,
   * and a rule written against it covers both.
   */
  it('finds a producer through a spelling only its aliases carry', async () => {
    const rows = await producers.searchByName(`Isle of ${TOKEN}`, 10);

    expect(rows.map((row) => row.name)).toEqual([ALIASED]);
  });
});
