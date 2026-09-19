import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreFlavorService } from '~core/flavor';
import { CoreProducerService } from '~core/producer';
import { PeatProfile, ProducerKind } from '~enums';
import { BadRequestError, DuplicateError } from '~errors';
import type { ProducerRuleCreateInput } from '~types';

import { KbReconcileService } from '~scrape/kb';

import { ProducerRuleFactory } from '../../src/domain/product/producer-rule.factory';
import { ProducerService } from '../../src/domain/product/producer.service';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * Prefix on every row this suite writes, so the cleanup can name exactly
 * what it made.
 *
 * This suite deliberately does **not** run inside `withRolledBackFixture`:
 * what it asserts is that a failed create rolls its own transaction back,
 * and an outer transaction would be aborted by that same failure, leaving
 * nothing readable afterwards.
 */
const TAG = 'itpc';

/**
 * A rule the whole suite reuses — two of it collide on
 * `flavor_rule_uindex`, which is the failure the rollback is tested with.
 */
const PEAT_RULE: ProducerRuleCreateInput = {
  pattern: `${TAG} heavy line`,
  peatProfile: PeatProfile.HEAVY,
};

describe('ProducerService.create', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let producers: CoreProducerService;
  let service: ProducerService;

  /**
   * Counts what the create left behind, by the tag every row carries.
   *
   * @param slug - The producer's slug.
   * @returns The producer, alias and rule rows that exist for it.
   */
  const countRows = async (slug: string): Promise<{
    producers: number;
    aliases: number;
    rules: number;
  }> => {
    const rows = await dataSource.query(
      `SELECT
         (SELECT count(*) FROM producer WHERE slug = $1) AS producers,
         (SELECT count(*) FROM producer_alias a
            JOIN producer p ON p.id = a."producerId"
           WHERE p.slug = $1) AS aliases,
         (SELECT count(*) FROM flavor_rule r
            JOIN producer p ON p.id = r."producerId"
           WHERE p.slug = $1) AS rules`,
      [slug],
    ) as { producers: string; aliases: string; rules: string }[];

    const row = rows[0];

    return {
      producers: Number(row?.producers ?? 0),
      aliases: Number(row?.aliases ?? 0),
      rules: Number(row?.rules ?? 0),
    };
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    producers = moduleRef.get(CoreProducerService, { strict: false });

    const flavors = moduleRef.get(CoreFlavorService, { strict: false });

    /**
     * The catalogue pass is stubbed: this suite is about what the create
     * writes, and re-resolving every bottling would touch rows it never
     * seeded.
     */
    const reconcile = {
      run: async () => ({ summary: { producers: 0, facts: 0, flavors: 0 } }),
    } as unknown as KbReconcileService;

    service = new ProducerService(
      producers,
      reconcile,
      new ProducerRuleFactory(flavors),
    );
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM producer WHERE slug LIKE '${TAG}-%'`);

    await closeIntegrationModule(moduleRef);
  });

  it('writes the row, its spellings and its rules in one request', async () => {
    const created = await service.create({
      name: `${TAG} full`,
      kind: ProducerKind.DISTILLERY,
      aliases: [`${TAG} shop spelling`],
      rules: [
        PEAT_RULE,
        { pattern: `${TAG} light line`, peatProfile: PeatProfile.LIGHT },
      ],
    });

    const detail = await producers.findDetail(created.producer.id);

    expect(detail?.rules).toHaveLength(2);
    expect(detail?.aliases).toHaveLength(2);
    expect(created.skippedAliases).toEqual([]);
  });

  it('leaves nothing behind when one of the rules collides', async () => {
    /**
     * The behaviour this suite exists for: the producer insert succeeds and
     * the second rule violates `flavor_rule_uindex`, so the transaction must
     * take the row and its spellings back with it.
     */
    const create = service.create({
      name: `${TAG} rolled back`,
      kind: ProducerKind.DISTILLERY,
      rules: [PEAT_RULE, PEAT_RULE],
    });

    await expect(create).rejects.toBeInstanceOf(DuplicateError);

    await expect(countRows(`${TAG}-rolled-back`)).resolves.toEqual({
      producers: 0,
      aliases: 0,
      rules: 0,
    });
  });

  it('refuses an unknown flavour before it writes anything', async () => {
    const create = service.create({
      name: `${TAG} unknown flavour`,
      kind: ProducerKind.DISTILLERY,
      rules: [
        {
          pattern: `${TAG} line`,
          flavorName: `${TAG}-no-such-flavor`,
          effect: 'require',
        } as ProducerRuleCreateInput,
      ],
    });

    await expect(create).rejects.toBeInstanceOf(BadRequestError);

    await expect(countRows(`${TAG}-unknown-flavour`)).resolves.toEqual({
      producers: 0,
      aliases: 0,
      rules: 0,
    });
  });
});
