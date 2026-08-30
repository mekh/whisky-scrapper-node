import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type { ID, ReportGroup, ReportOptions } from '~types';

import { ReportService } from '../../src/domain/report/report.service';
import { KbApplyService } from '../../src/scrape/kb/kb-apply.service';
import { KbResolverService } from '../../src/scrape/kb/kb-resolver.service';

import {
  clearCatalogue,
  ensureFlavors,
  installSeedKnowledgeBase,
  withRolledBackFixture,
} from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * No `user` row is needed: the per-user predicates are anti-joins against
 * tables this suite never writes, so any uuid reads as "a user with no
 * preferences".
 */
const USER_ID = '0198d1f6-0000-7000-8000-0000000000c1' as ID;

const STAMP = Date.now();

const SLUG = `__it_kb_${STAMP}`;

/**
 * A token no catalogue row can contain, appended to every seeded name so the
 * assertions scope themselves through the report's own name filter.
 *
 * Appending it does not break resolution: the resolver matches an alias as
 * whole words inside the name, so `Ledaig itkb…` still resolves to Ledaig.
 */
const TOKEN = `itkb${STAMP}`;

const DAY = '2026-07-25';

/**
 * Whiskies the owner's exclusion filter must remove, one per peat mechanism:
 * a sibling brand, three straightforwardly peated producers, a bottler's
 * blend, a producer brand, and one that reaches `heavy` only through a
 * global name rule.
 */
const PEATED = [
  'Ledaig',
  'Ardbeg',
  'Laphroaig',
  'Lagavulin',
  'Caol Ila',
  'Port Charlotte',
  'Smokehead',
  'Big Peat',
];

/**
 * Whiskies that must survive it. `Tobermory` is the reported bug — the
 * unpeated malt from Ledaig's own producer.
 */
const UNPEATED = ['Tobermory', 'Glenfiddich'];

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 100,
};

/**
 * How the sibling-brand check reads back out of the catalogue.
 */
interface SiblingRow {
  /**
   * The bottling's canonical name, token included.
   */
  name: string;

  /**
   * Slug of the producer the pass linked it to.
   */
  producer: string;

  /**
   * The peat band that producer states.
   */
  peatProfile: string;
}

/**
 * Everything the assertions read, gathered while the fixture transaction is
 * still open.
 */
interface KbReportFixture {
  /**
   * Names the report returns with no flavor filter.
   */
  all: string[];

  /**
   * Names it returns once peated whisky is excluded.
   */
  kept: string[];

  /**
   * Peat links on the seeded bottlings that the knowledge base does not own.
   */
  loosePeatLinks: number;

  /**
   * What the pass linked `Tobermory` and `Ledaig` to.
   */
  siblings: SiblingRow[];
}

/**
 * The acceptance criterion for the whole knowledge base, end to end.
 *
 * It installs the shipped knowledge base, seeds real catalogue names against
 * it, runs the same apply pass a sync runs, and then asks the report the
 * question the owner actually asks: exclude peated whisky. A bug anywhere in
 * that chain (alias, resolver, peat mapping, flavor write, filter predicate)
 * fails here.
 *
 * Each bottling is given a wrong `llm` peat tag first, so the test proves the
 * pass **removes** what a model guessed rather than merely declining to add
 * it — which is the half that made `Tobermory 12` disappear from the owner's
 * results in the first place.
 *
 * **Every row it reads is a row it wrote**, knowledge base included, inside a
 * transaction it rolls back. Reading the development database's own knowledge
 * base instead would have made the result depend on which producers that
 * machine's reviewer had promoted or ruled out — `Ledaig` rejected locally and
 * this suite fails on a catalogue that is perfectly correct.
 */
describe('peat exclusion end to end (integration)', () => {
  let moduleRef: TestingModule;
  let fixture: KbReportFixture;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();

    const dataSource = moduleRef.get(DataSource);
    const products = moduleRef.get(CoreProductService, { strict: false });
    const producers = moduleRef.get(CoreProducerService, {
      strict: false,
    });
    const offers = moduleRef.get(CoreStoreProductService, { strict: false });
    const snapshots = moduleRef.get(CorePriceSnapshotService, {
      strict: false,
    });

    const report = new ReportService(offers, snapshots);

    const names = (groups: ReportGroup[]): string[] =>
      groups.map((group) => group.name ?? group.nameOrig);

    const run = async (excludeFlavors?: string[]): Promise<string[]> => {
      const page = await report.report(
        ReportKind.CATALOG,
        { userId: USER_ID, name: TOKEN, excludeFlavors },
        OPTIONS,
      );

      return names(page.data);
    };

    fixture = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);
      await installSeedKnowledgeBase(dataSource);

      const flavors = await ensureFlavors(dataSource, ['peated', 'smoky']);
      const peatedId = flavors.get('peated');

      if (!peatedId) {
        throw new Error('The `peated` flavor could not be resolved');
      }

      const storeId = await seedStore(dataSource);

      const seeded = await seedBottlings(
        dataSource,
        { products, offers, snapshots },
        { storeId, peatedId },
      );

      await applyKnowledgeBase(producers, products, seeded);

      return {
        all: await run(),
        kept: await run(['peated']),
        loosePeatLinks: await countLoosePeatLinks(dataSource, seeded),
        siblings: await readSiblings(dataSource, seeded),
      };
    });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  it('seeded every bottling into the report', () => {
    expect(fixture.all).toHaveLength(PEATED.length + UNPEATED.length);
  });

  it('excludes every peated whisky and keeps Tobermory', () => {
    PEATED.forEach((label) => {
      expect(fixture.kept).not.toContain(`${label} ${TOKEN}`);
    });

    UNPEATED.forEach((label) => {
      expect(fixture.kept).toContain(`${label} ${TOKEN}`);
    });
  });

  /**
   * The hard invariant, asserted on the rows this suite created rather than on
   * the catalogue at large.
   */
  it('leaves every peat link owned by the knowledge base', () => {
    expect(fixture.loosePeatLinks).toBe(0);
  });

  /**
   * `Tobermory` and `Ledaig` come from one producer, and the resolver must
   * never inherit peat across that link — the whole reason a sibling brand is
   * its own row.
   */
  it('keeps the sibling brands apart', () => {
    expect(fixture.siblings).toEqual([
      expect.objectContaining({ producer: 'ledaig', peatProfile: 'heavy' }),
      expect.objectContaining({
        producer: 'tobermory',
        peatProfile: 'none',
      }),
    ]);
  });
});

/**
 * Creates the shop the seeded offers hang off.
 *
 * @param dataSource - The suite's data source.
 * @returns The store's id.
 * @throws {Error} When the insert returned no row.
 */
async function seedStore(dataSource: DataSource): Promise<ID> {
  const rows = await dataSource.query(
    `INSERT INTO store (slug, name, "baseUrl", active)
     VALUES ($1, 'IT KB Store', 'https://example.test', true)
     RETURNING id`,
    [SLUG],
  ) as { id: ID }[];

  const storeId = rows[0]?.id;

  if (!storeId) {
    throw new Error('Store insert returned nothing');
  }

  await dataSource.query(
    `INSERT INTO store_config
       ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
     VALUES ($1, 1, 0, 0, false, 'ts')`,
    [storeId],
  );

  return storeId;
}

/**
 * Creates one bottling per label, each carrying the wrong `llm` peat tag the
 * pass is meant to remove, listed and priced in the seeded shop.
 *
 * @param dataSource - The suite's data source.
 * @param services - The core services the write path goes through.
 * @param target - The shop to list in and the `peated` flavor id to mis-tag
 *   with.
 * @returns Label to bottling id.
 * @throws {Error} When an offer upsert returns nothing.
 */
async function seedBottlings(
  dataSource: DataSource,
  services: {
    products: CoreProductService;
    offers: CoreStoreProductService;
    snapshots: CorePriceSnapshotService;
  },
  target: { storeId: ID; peatedId: string },
): Promise<Map<string, ID>> {
  const seeded = new Map<string, ID>();
  let price = 100;

  for (const label of [...PEATED, ...UNPEATED]) {
    const name = `${label} ${TOKEN}`;

    const { ids } = await services.products.findOrCreateByMatchKeys([{
      factSources: {},
      matchKey: `${TOKEN}-${label}`,
      name,
      brandId: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: null,
      volumeMl: 700,
    }]);

    const productId = [...ids.values()][0];

    seeded.set(label, productId);

    await dataSource.query(
      `INSERT INTO product_flavor ("productId", "flavorId", source)
       VALUES ($1, $2, 'llm')
       ON CONFLICT ("productId", "flavorId") DO UPDATE SET source = 'llm'`,
      [productId, target.peatedId],
    );

    const offer = await services.offers.upsertFromScrape({
      storeId: target.storeId,
      productId,
      sku: `sku-${label}-${STAMP}`,
      url: `https://example.test/${label}`,
      nameOrig: name,
      seenOn: DAY,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    price += 10;

    await services.snapshots.upsertForDate(offer.id, DAY, {
      price,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });
  }

  return seeded;
}

/**
 * Runs the same apply pass a sync runs, over the same shared services.
 *
 * @param producers - The knowledge-base service.
 * @param products - The catalogue service.
 * @param seeded - The bottlings to reconcile.
 * @returns Resolves once the catalogue has been written.
 */
async function applyKnowledgeBase(
  producers: CoreProducerService,
  products: CoreProductService,
  seeded: Map<string, ID>,
): Promise<void> {
  const index = await producers.loadIndex();

  const typeNames = [
    ...new Set(
      index.aliases
        .map((alias) => alias.producer.defaultTypeName)
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  const typeIds = await producers.resolveTypeIds(typeNames);

  const rows = await products.findKbReconcileCandidates(
    undefined,
    undefined,
    [...seeded.values()],
  );

  const plan = new KbApplyService(new KbResolverService())
    .plan(rows, index, typeIds);

  await products.setProducers(plan.producers);
  await products.applyKbFacts(plan.facts);
  await products.applyKbFlavors(plan.flavors);
}

/**
 * Counts peat links on the seeded bottlings that something other than the
 * knowledge base or a person owns.
 *
 * @param dataSource - The suite's data source.
 * @param seeded - The bottlings to check.
 * @returns How many such links survived the pass.
 */
async function countLoosePeatLinks(
  dataSource: DataSource,
  seeded: Map<string, ID>,
): Promise<number> {
  const rows = await dataSource.query(
    `SELECT count(*)::int AS total
     FROM product_flavor pf
     JOIN flavor f ON f.id = pf."flavorId"
     WHERE pf."productId" = ANY($1::uuid[])
       AND f.name IN ('peated', 'smoky')
       AND pf.source NOT IN ('kb', 'manual')`,
    [[...seeded.values()]],
  ) as { total: number }[];

  return rows[0]?.total ?? 0;
}

/**
 * Reads back what the pass linked the two sibling brands to.
 *
 * @param dataSource - The suite's data source.
 * @param seeded - The bottlings to look in.
 * @returns One row per sibling, by name.
 */
async function readSiblings(
  dataSource: DataSource,
  seeded: Map<string, ID>,
): Promise<SiblingRow[]> {
  return dataSource.query(
    `SELECT p.name, d.slug AS producer, d."peatProfile"
     FROM product p
     JOIN producer d ON d.id = p."producerId"
     WHERE p.id = ANY($1::uuid[])
       AND p.name LIKE ANY (ARRAY['Tobermory%', 'Ledaig%'])
     ORDER BY p.name`,
    [[...seeded.values()]],
  ) as Promise<SiblingRow[]>;
}
