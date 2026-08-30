import 'reflect-metadata';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { PeatProfile, ProducerAliasScope, ProducerKind } from '~enums';
import { KbResolverService } from '~scrape/kb';
import { KbKeyUtils } from '~utils';

import { ProducerReachService } from '../src/domain/product/producer-reach.service';

import type {
  KbAliasEntry,
  KbIndex,
  KbProducerFacts,
  KbReconcileRow,
} from '~types';

/**
 * Builds a producer with sane defaults, so a case states only the facts it
 * actually cares about.
 *
 * @param slug - The producer slug, reused as its id.
 * @param over - The facts this case cares about.
 * @returns The producer facts.
 */
function producer(
  slug: string,
  over: Partial<KbProducerFacts> = {},
): KbProducerFacts {
  return {
    id: slug,
    slug,
    name: slug,
    kind: ProducerKind.DISTILLERY,
    countryId: null,
    region: null,
    legalRegion: null,
    parentId: null,
    bottlerId: null,
    defaultTypeName: null,
    peatProfile: PeatProfile.UNKNOWN,
    ...over,
  };
}

/**
 * Builds one alias entry, normalizing the spelling the way the seed importer
 * would.
 *
 * @param facts - The producer the spelling names.
 * @param rawKey - The raw spelling.
 * @param scope - Where the alias may be matched.
 * @returns The alias entry.
 */
function alias(
  facts: KbProducerFacts,
  rawKey: string,
  scope: ProducerAliasScope = ProducerAliasScope.ANY,
): KbAliasEntry {
  return { key: KbKeyUtils.key(rawKey), scope, producer: facts };
}

/**
 * Builds a catalogue row with sane defaults, so a case states only the id,
 * name and brand it actually cares about.
 *
 * @param id - The bottling id.
 * @param name - The canonical product name, or null.
 * @param over - The fields this case cares about.
 * @returns The reconcile row.
 */
function row(
  id: string,
  name: string | null,
  over: Partial<KbReconcileRow> = {},
): KbReconcileRow {
  return {
    id,
    name,
    brand: null,
    countryId: null,
    countrySource: null,
    typeId: null,
    typeSource: null,
    producerId: null,
    bottlerId: null,
    flavorsCuratedAt: null,
    flavors: [],
    ...over,
  };
}

/**
 * Assembles the `KbIndex` that `loadIndex` would return. `withheldReach`
 * never reads the rules or the house styles, so a case need only state its
 * live aliases.
 *
 * @param aliases - The verified/auto aliases.
 * @returns The index.
 */
function liveIndex(aliases: KbAliasEntry[]): KbIndex {
  return {
    aliases,
    rules: [],
    producerFlavors: new Map(),
    peatFlavorIds: { peated: null, smoky: null },
  };
}

/**
 * Wires a `ProducerReachService` whose two core-layer collaborators are
 * fakes and whose resolver is the real `KbResolverService` — the point of
 * this suite is the composition between them, not a resolver double.
 *
 * @param live - The verified/auto aliases `loadIndex` would carry.
 * @param withheld - The aliases of the withheld producers.
 * @param rows - The catalogue `findKbReconcileCandidates` would return.
 * @returns The wired service.
 */
function makeService(
  live: KbAliasEntry[],
  withheld: KbAliasEntry[],
  rows: KbReconcileRow[],
): ProducerReachService {
  const producers = {
    loadIndex: jest.fn().mockResolvedValue(liveIndex(live)),
    loadWithheldAliasIndex: jest.fn().mockResolvedValue(withheld),
  };

  const products = {
    findKbReconcileCandidates: jest.fn().mockResolvedValue(rows),
  };

  return new ProducerReachService(
    producers as unknown as CoreProducerService,
    products as unknown as CoreProductService,
    new KbResolverService(),
  );
}

describe('ProducerReachService.withheldReach', () => {
  it('counts rows, not name groups, when bottlings share a name', async () => {
    const macduff = producer('macduff');

    const service = makeService(
      [],
      [alias(macduff, 'Macduff')],
      [row('row-1', 'Macduff 12'), row('row-2', 'macduff 12')],
    );

    const reach = await service.withheldReach();

    expect(reach.get('macduff')).toBe(2);
  });

  it('never credits a producer that resolved live, not withheld', async () => {
    const glendullan = producer('glendullan');

    const service = makeService(
      [alias(glendullan, 'Glendullan')],
      [],
      [row('row-1', 'Glendullan 12')],
    );

    const reach = await service.withheldReach();

    expect(reach.size).toBe(0);
  });

  it('credits a withheld bottler through the bottler slot', async () => {
    const bottler = producer('douglas-laing', { kind: ProducerKind.BOTTLER });

    const service = makeService(
      [],
      [alias(bottler, 'Douglas Laing')],
      [row('row-1', 'Douglas Laing Cask Strength')],
    );

    const reach = await service.withheldReach();

    expect(reach.get('douglas-laing')).toBe(1);
  });

  it('re-sorts the merge so a longer withheld alias still wins', async () => {
    const highland = producer('highland');
    const highlandQueen = producer('highland-queen');

    /**
     * `highland` is live and shorter; `highland queen` is withheld and
     * longer, and both match the name below. `matchInName` takes the first
     * alias whose key appears in the name, so only a merge that re-sorts by
     * key length rather than concatenating the two lists puts the longer,
     * withheld alias first.
     */
    const service = makeService(
      [alias(highland, 'Highland', ProducerAliasScope.NAME)],
      [alias(highlandQueen, 'Highland Queen', ProducerAliasScope.NAME)],
      [row('row-1', 'Highland Queen')],
    );

    const reach = await service.withheldReach();

    expect(reach.get('highland-queen')).toBe(1);
    expect(reach.has('highland')).toBe(false);
  });

  it(
    'leaves an unreached withheld producer out of the map, not at zero',
    async () => {
      const orphan = producer('orphan-distillery');
      const reached = producer('reached-distillery');

      const service = makeService(
        [],
        [
          alias(orphan, 'Orphan Distillery'),
          alias(reached, 'Reached Distillery'),
        ],
        [row('row-1', 'Reached Distillery 12')],
      );

      const reach = await service.withheldReach();

      expect(reach.get('reached-distillery')).toBe(1);
      expect(reach.has('orphan-distillery')).toBe(false);
    },
  );
});
