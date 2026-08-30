import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreProducerService } from '~core/producer';
import { KbResolverService } from '~scrape/kb/kb-resolver.service';
import type { ID, KbIndex, KbResolution } from '~types';

import {
  installSeedKnowledgeBase,
  withRolledBackFixture,
} from '../integration/database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from '../integration/integration-module';

/**
 * One reviewed expectation: a real catalogue `(name, brand)` pair and what the
 * knowledge base must say about it.
 */
interface GoldenRow {
  /**
   * The bottling's canonical name, exactly as the catalogue stores it.
   */
  name: string;

  /**
   * The brand value the catalogue carries, empty when the product has none.
   */
  brand: string;

  /**
   * Expected producer slug. Empty is a real expectation — an undisclosed label
   * must resolve to nothing rather than to a guess.
   */
  producer: string;

  /**
   * Expected bottler slug, empty when the bottling is not an independent one.
   */
  bottler: string;

  /**
   * Expected common region of the producer, empty outside Scotland.
   */
  region: string;

  /**
   * Expected `PeatProfile` value.
   */
  peat: string;

  /**
   * Expected `defaultTypeName` of the producer, empty when its range spans
   * several types.
   */
  type: string;

  /**
   * Expected country code of the producer.
   */
  country: string;
}

/**
 * Where the fixture lives, relative to this file.
 */
const FIXTURE = join(__dirname, '..', 'fixtures', 'kb-golden.tsv');

/**
 * Reads the golden fixture.
 *
 * @returns Every expectation in file order.
 */
function readFixture(): GoldenRow[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const f = line.split('\t');

      return {
        name: f[0] ?? '',
        brand: f[1] ?? '',
        producer: f[2] ?? '',
        bottler: f[3] ?? '',
        region: f[4] ?? '',
        peat: f[5] ?? '',
        type: f[6] ?? '',
        country: f[7] ?? '',
      };
    });
}

/**
 * The knowledge base's behaviour, pinned against the seed that ships.
 *
 * This is the regression gate the whole knowledge base is measured by. It runs
 * the real resolver over the real index, so it fails on a change to the seed,
 * to the resolver, or to the auto-gate alike — which is the point: every one of
 * those can silently move a whisky in or out of a peat filter, and that failure
 * mode is invisible in production until somebody notices a favourite has
 * vanished.
 *
 * **The suite installs that seed itself**, by running the four seed migrations
 * inside a transaction it rolls back. It used to read whatever knowledge base
 * the development database happened to hold, which made it a test of one
 * machine's review history rather than of the seed: promoting a producer
 * locally turned rows green that ship withheld, so the fixture drifted away
 * from what production would resolve. What the expectations below pin is the
 * checked-in TSVs, in every environment.
 *
 * Expectations are compared in one pass and reported together rather than one
 * `expect` per row. A seed change typically moves many rows at once, and a
 * list of every difference is what a reviewer needs in order to decide whether
 * the change was an improvement; a single first failure hides that.
 */
describe('knowledge base golden set (integration)', () => {
  let moduleRef: TestingModule;
  let index: KbIndex;
  let rows: GoldenRow[];
  let resolutions: KbResolution[];
  let codes: Map<ID, string>;

  const actual = (row: KbResolution): GoldenRow => {
    const producer = row.producer;

    return {
      name: '',
      brand: '',
      producer: producer?.slug ?? '',
      bottler: row.bottler?.slug ?? '',
      region: producer?.region ?? '',
      peat: row.peatProfile,
      type: producer?.defaultTypeName ?? '',
      country: producer?.countryId
        ? codes.get(producer.countryId) ?? ''
        : '',
    };
  };

  const resolutionFor = (name: string): KbResolution => {
    const at = rows.findIndex((row) => row.name === name);

    expect(at).toBeGreaterThanOrEqual(0);

    return resolutions[at];
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();

    const producers = moduleRef.get(CoreProducerService, { strict: false });

    const dataSource = moduleRef.get(DataSource);

    rows = readFixture();

    const fixture = await withRolledBackFixture(async () => {
      await installSeedKnowledgeBase(dataSource);

      const countries = await dataSource.query(
        'SELECT id, code FROM country',
      ) as { id: ID; code: string }[];

      return {
        index: await producers.loadIndex(),
        codes: new Map(countries.map((one) => [one.id, one.code])),
      };
    });

    index = fixture.index;
    codes = fixture.codes;

    resolutions = new KbResolverService().resolve(
      rows.map((row, at) => ({
        id: String(at) as ID,
        name: row.name,
        brand: row.brand || null,
      })),
      index,
    );
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  /**
   * A floor, not a count. The index deliberately holds only the aliases of
   * producers the auto-gate let through, so the number is far below the
   * seeded 1046 and moves whenever the seed grows — asserting the exact value
   * would turn every research batch into a failing test.
   */
  it('has a seeded knowledge base to resolve against', () => {
    expect(rows.length).toBeGreaterThan(150);
    expect(index.aliases.length).toBeGreaterThan(400);
    expect(index.rules.length).toBeGreaterThan(50);
  });

  it('matches every reviewed expectation', () => {
    const failures: string[] = [];

    rows.forEach((want, at) => {
      const got = actual(resolutions[at]);

      (['producer', 'bottler', 'region', 'peat', 'type', 'country'] as const)
        .forEach((field) => {
          if (got[field] !== want[field]) {
            failures.push(
              `${want.name} [${want.brand}] ${field}: `
                + `expected '${want[field]}', got '${got[field]}'`,
            );
          }
        });
    });

    expect(failures).toEqual([]);
  });

  /**
   * The bug that started the work, asserted on its own so a failure names it.
   */
  it('keeps Tobermory unpeated and Ledaig peated', () => {
    const tobermory = resolutionFor('Tobermory');
    const ledaig = resolutionFor('Ledaig');

    expect(tobermory.producer?.slug).toBe('tobermory');
    expect(tobermory.peatProfile).toBe('none');
    expect(KbResolverService.peatTags(tobermory.peatProfile)).toEqual([]);

    expect(ledaig.producer?.slug).toBe('ledaig');
    expect(ledaig.producer?.parentId).toBe(tobermory.producer?.id);
    expect(ledaig.peatProfile).toBe('heavy');
    expect(KbResolverService.peatTags(ledaig.peatProfile))
      .toEqual(['peated', 'smoky']);
  });

  /**
   * The independent-bottler path: the brand names the bottler, the distillery
   * is only inside the product name, and the facts must come from the
   * distillery.
   */
  it('reads an independent bottling from the distillery in its name', () => {
    const bottled = resolutionFor('Gordon & MacPhail Ledaig Discovery');

    expect(bottled.producer?.slug).toBe('ledaig');
    expect(bottled.bottler?.slug).toBe('gordon-macphail');
    expect(bottled.peatProfile).toBe('heavy');
  });

  /**
   * A bottler is never a producer. Before the golden set this row resolved its
   * producer to Old Malt Cask and its bottler to nothing.
   */
  it('never puts a bottler in the producer slot', () => {
    const named = resolutionFor('Old Malt Cask Jura');

    expect(named.producer).toBeNull();
    expect(named.bottler?.slug).toBe('old-malt-cask');
  });

  /**
   * An undisclosed label states nothing, and nothing is the answer.
   */
  it('refuses to guess an undisclosed distillery', () => {
    const secret = resolutionFor(
      "Douglas Laing & Co Old Particular Probably Orkney's Finest",
    );

    expect(secret.producer).toBeNull();
    expect(secret.bottler?.slug).toBe('douglas-laing');
    expect(secret.peatProfile).toBe('unknown');
  });

  /**
   * A negation in the bottling's own name overrules its house profile, and a
   * qualified form overrules the bare keyword. Both are priority decisions in
   * the global rules, and both are real catalogue rows.
   */
  it('lets a name overrule the house profile', () => {
    expect(resolutionFor('Benromach Unpeated').peatProfile).toBe('none');
    expect(resolutionFor('Bunnahabhain Moine').peatProfile).toBe('heavy');
    expect(resolutionFor('Mac-Talla Flora Lightly Peated Morrison').peatProfile)
      .toBe('light');
  });

  /**
   * Smoke words state smokiness, never peat — the split the vocabulary exists
   * for. `Johnny Smoking Gun` additionally proves the matching is whole-word:
   * `smoking` must not fire the `smoke` rule.
   */
  it('never derives peat from a smoke word', () => {
    ["Grant's Triple Wood Smoky", 'Johnny Smoking Gun']
      .forEach((name) => {
        expect(resolutionFor(name).peatProfile).not.toBe('heavy');
        expect(resolutionFor(name).peatProfile).not.toBe('medium');
      });
  });

  /**
   * The three-way collision a short alias would cause. `Elements of Islay` is
   * a bottler range, `M&H Elements` is an Israeli distillery's line and
   * `Glenmorangie Elementa` is neither.
   */
  it('keeps the Elements family apart', () => {
    expect(resolutionFor('Elements of Islay').bottler?.slug)
      .toBe('elements-of-islay');
    expect(resolutionFor('M&H Elements Peated Malt').producer?.slug)
      .toBe('m-h');
    expect(resolutionFor('Glenmorangie Elementa').producer?.slug)
      .toBe('glenmorangie');
  });

  /**
   * Every whisky the owner's exclusion filter must remove, and the one it must
   * keep. This is the end-to-end acceptance restated at the resolver level, so
   * it fails here first if a seed change breaks it.
   */
  it('tags every whisky the peat filter must exclude', () => {
    const excluded = [
      'Ledaig',
      'Ардбег',
      'Big Peat',
      'Octomore 13.3',
      'Smokehead',
    ];

    excluded.forEach((name) => {
      expect(KbResolverService.peatTags(resolutionFor(name).peatProfile))
        .toContain('peated');
    });

    expect(KbResolverService.peatTags(resolutionFor('Tobermory').peatProfile))
      .not.toContain('peated');
  });
});
