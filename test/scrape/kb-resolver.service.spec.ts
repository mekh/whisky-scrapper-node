import 'reflect-metadata';

import {
  FlavorRuleMatchMode,
  KbFlavorEffect,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
} from '~enums';
import { KbPeatReason } from '~types';
import { KbKeyUtils } from '~utils';

import { KbResolverService } from '../../src/scrape/kb/kb-resolver.service';

import type {
  ID,
  KbAliasEntry,
  KbFlavorRule,
  KbIndex,
  KbProducerFacts,
  KbProducerFlavor,
  KbResolution,
} from '~types';

const resolver = new KbResolverService();

const PEATED = 'flavor-peated';
const SMOKY = 'flavor-smoky';
const SHERRY = 'flavor-sherry';
const FRUITY = 'flavor-fruity';

/**
 * Builds a producer with sane defaults, so a case states only the facts it is
 * actually about.
 *
 * @param slug - The producer slug, which doubles as its id in these fixtures.
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
 * Builds alias entries for a producer, normalizing each spelling the way the
 * seed importer would.
 *
 * @param facts - The producer the spellings name.
 * @param keys - The raw spellings.
 * @param scope - Where the aliases may be matched.
 * @returns The alias entries.
 */
function aliases(
  facts: KbProducerFacts,
  keys: string[],
  scope: ProducerAliasScope = ProducerAliasScope.ANY,
): KbAliasEntry[] {
  return keys.map((key) => ({
    key: KbKeyUtils.key(key),
    scope,
    producer: facts,
  }));
}

/**
 * Builds a peat rule.
 *
 * @param pattern - The raw pattern, normalized here.
 * @param peatProfile - The level the pattern implies.
 * @param over - Priority, scope or match mode when the case cares.
 * @returns The rule.
 */
function peatRule(
  pattern: string,
  peatProfile: PeatProfile,
  over: Partial<KbFlavorRule> = {},
): KbFlavorRule {
  return {
    producerId: null,
    pattern: KbKeyUtils.key(pattern),
    matchMode: FlavorRuleMatchMode.WORD,
    flavorId: null,
    effect: null,
    peatProfile,
    priority: 50,
    ...over,
  };
}

/**
 * Builds a tag rule.
 *
 * @param pattern - The raw pattern, normalized here.
 * @param flavorId - The tag the rule acts on.
 * @param effect - Whether the tag is required or forbidden.
 * @param over - Scope or priority when the case cares.
 * @returns The rule.
 */
function tagRule(
  pattern: string,
  flavorId: ID,
  effect: KbFlavorEffect,
  over: Partial<KbFlavorRule> = {},
): KbFlavorRule {
  return {
    producerId: null,
    pattern: KbKeyUtils.key(pattern),
    matchMode: FlavorRuleMatchMode.WORD,
    flavorId,
    effect,
    peatProfile: null,
    priority: 20,
    ...over,
  };
}

/**
 * Assembles an index, ordering aliases and rules the way the repository's SQL
 * does — longest alias first, and rules by descending priority then descending
 * pattern length. The resolver relies on that ordering, so a fixture that did
 * not reproduce it would test something the production path never sees.
 *
 * @param parts - The aliases, rules and house-style rows for this case.
 * @returns The index.
 */
function index(parts: {
  aliases?: KbAliasEntry[];
  rules?: KbFlavorRule[];
  producerFlavors?: [ID, KbProducerFlavor[]][];
}): KbIndex {
  return {
    aliases: [...parts.aliases ?? []]
      .sort((left, right) => right.key.length - left.key.length),
    rules: [...parts.rules ?? []].sort((left, right) =>
      right.priority - left.priority
      || right.pattern.length - left.pattern.length
    ),
    producerFlavors: new Map(parts.producerFlavors ?? []),
    peatFlavorIds: { peated: PEATED, smoky: SMOKY },
  };
}

/**
 * Resolves a single bottling.
 *
 * @param name - The canonical product name.
 * @param brand - The brand value, when the case has one.
 * @param kb - The index to resolve against.
 * @returns The resolution.
 */
function resolve(
  name: string,
  brand: string | null,
  kb: KbIndex,
): KbResolution {
  return resolver.resolve([{ id: 'p1', name, brand }], kb)[0];
}

/**
 * Tobermory and Ledaig come from one distillery: Tobermory is unpeated and
 * Ledaig is heavily peated. That pair is the bug this whole subsystem exists
 * for — a model asked about "Tobermory" reaches the island, the island reaches
 * Ledaig, and the user's favourite malt disappeared from every result because
 * he filters peat out.
 */
const TOBERMORY = producer('tobermory', {
  peatProfile: PeatProfile.NONE,
  countryId: 'country-scotland',
  defaultTypeName: 'single malt',
});
const LEDAIG = producer('ledaig', {
  kind: ProducerKind.BRAND,
  parentId: TOBERMORY.id,
  peatProfile: PeatProfile.HEAVY,
  countryId: 'country-scotland',
  defaultTypeName: 'single malt',
});
const DOUGLAS_LAING = producer('douglas-laing', {
  kind: ProducerKind.BOTTLER,
});
const BRUICHLADDICH = producer('bruichladdich', {
  peatProfile: PeatProfile.NONE,
});
const PORT_CHARLOTTE = producer('port-charlotte', {
  kind: ProducerKind.BRAND,
  parentId: BRUICHLADDICH.id,
  peatProfile: PeatProfile.HEAVY,
});

const SIBLINGS = index({
  aliases: [
    ...aliases(TOBERMORY, ['Tobermory']),
    ...aliases(LEDAIG, ['Ledaig']),
    ...aliases(DOUGLAS_LAING, ['Douglas Laing', 'Douglas Laingcompany']),
    ...aliases(BRUICHLADDICH, ['Bruichladdich']),
    ...aliases(PORT_CHARLOTTE, ['Port Charlotte']),
  ],
  rules: [],
});

describe('KbResolverService: the sibling-brand collision', () => {
  it('keeps Tobermory unpeated', () => {
    const result = resolve('Tobermory', 'Tobermory', SIBLINGS);

    expect(result.producer?.slug).toBe('tobermory');
    expect(result.peatProfile).toBe(PeatProfile.NONE);
    expect(KbResolverService.peatTags(result.peatProfile)).toEqual([]);
  });

  it('keeps Ledaig heavily peated', () => {
    const result = resolve('Ledaig', 'Ledaig', SIBLINGS);

    expect(result.producer?.slug).toBe('ledaig');
    expect(KbResolverService.peatTags(result.peatProfile))
      .toEqual(['peated', 'smoky']);
  });

  it('never inherits a parent distillery peat level through parentId', () => {
    const result = resolve('Ledaig 10', 'Ledaig', SIBLINGS);

    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
    expect(result.producer?.parentId).toBe('tobermory');
  });

  it('prefers the specific brand named in the product name', () => {
    const result = resolve(
      'Bruichladdich Port Charlotte Islay Barley',
      'Bruichladdich',
      SIBLINGS,
    );

    expect(result.producer?.slug).toBe('port-charlotte');
    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
  });
});

describe('KbResolverService: independent bottlings', () => {
  it('reads the distillery out of the name, not the bottler', () => {
    const result = resolve(
      'Gordon & MacPhail Ledaig Discovery',
      'Douglas Laing',
      SIBLINGS,
    );

    expect(result.bottler?.slug).toBe('douglas-laing');
    expect(result.producer?.slug).toBe('ledaig');
    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
  });

  it('does not let a bottler brand claim an unpeated distillery', () => {
    const result = resolve(
      'Douglas Laing Tobermory',
      'Douglas Laing',
      SIBLINGS,
    );

    expect(result.bottler?.slug).toBe('douglas-laing');
    expect(result.producer?.slug).toBe('tobermory');
    expect(result.peatProfile).toBe(PeatProfile.NONE);
  });

  /**
   * The catalogue spells some brand values in a way no alias matches
   * (`Allt A Bhainne` against a seed that only knew `Allt-a-Bhainne`), so the
   * only thing found is the bottler's own name inside the title. Arbitration
   * has no reason of its own to refuse it, and the row then read its country,
   * type and peat off a company that owns no still.
   */
  it('never resolves a bottler as the producer, even alone', () => {
    const result = resolve('Allt-a-Bhainne - Old Malt Cask', 'Unknown Brand', {
      aliases: aliases(
        producer('old-malt-cask', {
          kind: ProducerKind.BOTTLER,
        }),
        ['Old Malt Cask'],
      ),
      rules: [],
      producerFlavors: new Map(),
      peatFlavorIds: { peated: PEATED, smoky: SMOKY },
    });

    expect(result.producer).toBeNull();
    expect(result.bottler?.slug).toBe('old-malt-cask');
    expect(result.peatProfile).toBe(PeatProfile.UNKNOWN);
  });

  it('leaves an undisclosed bottling unresolved rather than guessing', () => {
    const result = resolve(
      "Douglas Laing Old Particular Probably Orkney's Finest",
      'Douglas Laing',
      SIBLINGS,
    );

    expect(result.bottler?.slug).toBe('douglas-laing');
    expect(result.producer).toBeNull();
    expect(result.peatProfile).toBe(PeatProfile.UNKNOWN);
    expect(KbResolverService.peatTags(result.peatProfile)).toEqual([]);
  });
});

describe('KbResolverService: name rules', () => {
  const BENROMACH = producer('benromach', {
    peatProfile: PeatProfile.LIGHT,
  });
  const BUNNAHABHAIN = producer('bunnahabhain', {
    peatProfile: PeatProfile.NONE,
  });

  const RULES = index({
    aliases: [
      ...aliases(BENROMACH, ['Benromach']),
      ...aliases(BUNNAHABHAIN, ['Bunnahabhain']),
      ...aliases(TOBERMORY, ['Tobermory']),
    ],
    rules: [
      peatRule('unpeated', PeatProfile.NONE, { priority: 100 }),
      peatRule('lightly peated', PeatProfile.LIGHT, { priority: 60 }),
      peatRule('heavily peated', PeatProfile.HEAVY, { priority: 60 }),
      peatRule('peated', PeatProfile.HEAVY),
      peatRule('торф', PeatProfile.HEAVY, {
        matchMode: FlavorRuleMatchMode.PREFIX,
      }),
      peatRule('moine', PeatProfile.HEAVY, {
        producerId: BUNNAHABHAIN.id,
        priority: 60,
      }),
    ],
  });

  it('lets an explicit negation outrank the house profile', () => {
    const result = resolve('Benromach Unpeated', 'Benromach', RULES);

    expect(result.peatProfile).toBe(PeatProfile.NONE);
    expect(result.peatReason).toBe(KbPeatReason.RULE_GLOBAL);
    expect(result.peatRulePattern).toBe('unpeated');
  });

  it('reads "lightly peated" as light, not as the bare peated keyword', () => {
    const result = resolve('Mac-Talla Flora Lightly Peated', null, RULES);

    expect(result.peatProfile).toBe(PeatProfile.LIGHT);
    expect(KbResolverService.peatTags(result.peatProfile)).toEqual(['smoky']);
  });

  it('applies a producer-scoped rule over the unpeated core range', () => {
    const result = resolve('Bunnahabhain Moine', 'Bunnahabhain', RULES);

    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
    expect(result.peatReason).toBe(KbPeatReason.RULE_PRODUCER);
  });

  it('matches Ukrainian inflection through a prefix rule', () => {
    const result = resolve("Віскі торф'яний", null, RULES);

    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
  });

  it('folds diacritics so Mòine and Moine are one pattern', () => {
    const result = resolve('Bunnahabhain Mòine', 'Bunnahabhain', RULES);

    expect(result.peatProfile).toBe(PeatProfile.HEAVY);
  });

  it('matches whole words only, so a name is not read for a substring', () => {
    const result = resolve('Johnny Smoking Gun', null, RULES);

    expect(result.peatProfile).toBe(PeatProfile.UNKNOWN);
    expect(KbResolverService.peatTags(result.peatProfile)).toEqual([]);
  });

  it('does not let a scoped rule fire for another producer', () => {
    const result = resolve('Tobermory Moine Edition', 'Tobermory', RULES);

    expect(result.peatProfile).toBe(PeatProfile.NONE);
  });
});

describe('KbResolverService: the light band', () => {
  it('yields smoky without peated, so a peat filter still keeps it', () => {
    expect(KbResolverService.peatTags(PeatProfile.LIGHT)).toEqual(['smoky']);
  });

  it('yields nothing for none and unknown alike', () => {
    expect(KbResolverService.peatTags(PeatProfile.NONE)).toEqual([]);
    expect(KbResolverService.peatTags(PeatProfile.UNKNOWN)).toEqual([]);
  });
});

describe('KbResolverService: the other thirteen tags', () => {
  const GLENFIDDICH = producer('glenfiddich', {
    peatProfile: PeatProfile.NONE,
  });

  const TAGS = index({
    aliases: aliases(GLENFIDDICH, ['Glenfiddich']),
    rules: [
      tagRule('oloroso', SHERRY, KbFlavorEffect.REQUIRE),
      tagRule('sherry cask', SHERRY, KbFlavorEffect.REQUIRE),
    ],
    producerFlavors: [[
      GLENFIDDICH.id,
      [
        {
          producerId: GLENFIDDICH.id,
          flavorId: FRUITY,
          effect: KbFlavorEffect.BASELINE,
        },
        {
          producerId: GLENFIDDICH.id,
          flavorId: SHERRY,
          effect: KbFlavorEffect.FORBID,
        },
      ],
    ]],
  });

  it('carries a house style as baseline, not as an assertion', () => {
    const result = resolve('Glenfiddich 12', 'Glenfiddich', TAGS);

    expect(result.baselineFlavorIds).toEqual([FRUITY]);
    expect(result.requiredFlavorIds).toEqual([]);
  });

  it('forbids a tag the house style rules out', () => {
    const result = resolve('Glenfiddich 12', 'Glenfiddich', TAGS);

    expect(result.forbiddenFlavorIds).toContain(SHERRY);
  });

  it('lets the bottling own name overrule the house style', () => {
    const result = resolve(
      'Glenfiddich 15 Sherry Cask',
      'Glenfiddich',
      TAGS,
    );

    expect(result.requiredFlavorIds).toContain(SHERRY);
    expect(result.forbiddenFlavorIds).not.toContain(SHERRY);
  });

  it('never offers a forbidden tag as a baseline fill', () => {
    const forbidding = index({
      aliases: aliases(GLENFIDDICH, ['Glenfiddich']),
      producerFlavors: [[
        GLENFIDDICH.id,
        [
          {
            producerId: GLENFIDDICH.id,
            flavorId: SHERRY,
            effect: KbFlavorEffect.BASELINE,
          },
          {
            producerId: GLENFIDDICH.id,
            flavorId: SHERRY,
            effect: KbFlavorEffect.FORBID,
          },
        ],
      ]],
    });

    const result = resolve('Glenfiddich 12', 'Glenfiddich', forbidding);

    expect(result.baselineFlavorIds).not.toContain(SHERRY);
  });
});

describe('KbResolverService: unresolved input', () => {
  it('resolves nothing for a brand the knowledge base does not know', () => {
    const result = resolve('Some Own Label Blend', 'Own Label', SIBLINGS);

    expect(result.producer).toBeNull();
    expect(result.bottler).toBeNull();
    expect(result.peatReason).toBe(KbPeatReason.UNRESOLVED);
  });

  it('tolerates a bottling with no name at all', () => {
    const result = resolve('', null, SIBLINGS);

    expect(result.producer).toBeNull();
    expect(result.peatProfile).toBe(PeatProfile.UNKNOWN);
  });

  it('resolves a catalogue typo through its alias', () => {
    const result = resolve('Ledaig 18', 'Douglas Laingcompany', SIBLINGS);

    expect(result.bottler?.slug).toBe('douglas-laing');
    expect(result.producer?.slug).toBe('ledaig');
  });
});

/**
 * Brand scope is the one place an alias is compared as a whole string rather
 * than looked for inside a name, and the asymmetry is load-bearing: it is what
 * keeps a short or generic alias unambiguous, and it is why the five-character
 * floor exempts brand scope entirely.
 *
 * The seed shipped `whisky` (brand scope) for goodwine's category label — a
 * researcher wrote the alias as the exact catalogue string `& Whisky` and
 * `KbKeyUtils.key` deleted the ampersand. Exact matching is the only reason
 * that row stayed confined to bottlings whose brand column was already wrong,
 * instead of claiming every whisky in the catalogue the way its twin in the
 * `brand` table did.
 */
describe('KbResolverService: brand-scoped aliases are exact', () => {
  const BRAND_SCOPED = index({
    aliases: [
      ...aliases(TOBERMORY, ['Tobermory'], ProducerAliasScope.BRAND),
      ...aliases(LEDAIG, ['Ledaig']),
    ],
    rules: [],
  });

  it('matches a brand-scoped alias only as the whole brand value', () => {
    expect(resolve('Some Malt', 'Tobermory', BRAND_SCOPED).producer?.slug)
      .toBe('tobermory');
    expect(
      resolve('Some Malt', 'Tobermory Distillery', BRAND_SCOPED).producer,
    ).toBeNull();
  });

  it('never fires a brand-scoped alias from inside a product name', () => {
    const result = resolve('Tobermory 12 Single Malt', null, BRAND_SCOPED);

    expect(result.producer).toBeNull();
    expect(result.peatReason).toBe(KbPeatReason.UNRESOLVED);
  });
});
