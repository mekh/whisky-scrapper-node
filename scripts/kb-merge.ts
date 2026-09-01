import 'dotenv/config';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  FlavorRuleMatchMode,
  KB_NAME_ALIAS_MIN_LENGTH,
  KbFlavorEffect,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import { KbGateUtils, KbKeyUtils, ProductMatchUtils } from '~utils';

import type {
  KbAliasRow,
  KbFlavorRow,
  KbMergeReport,
  KbOverride,
  KbProducerRow,
  KbRuleRow,
  KbSlugMerge,
} from './kb-merge.interfaces';

/**
 * The closed flavor vocabulary, matching the `flavor` table. `peated` is in the
 * list because a rule may state it; a house-style row may not (see
 * {@link readFlavors}).
 */
const FLAVORS = new Set([
  'bourbon-cask',
  'caramel',
  'chocolate',
  'citrus',
  'floral',
  'fruity',
  'honey',
  'maritime',
  'nutty',
  'oak',
  'peated',
  'sherry',
  'smoky',
  'spicy',
  'vanilla',
]);

/**
 * The whisky types the `type` table holds. A producer's `defaultTypeName` must
 * be one of these or the migration's join would drop it silently.
 */
const TYPES = new Set([
  'blend',
  'bourbon',
  'grain',
  'malt',
  'rye',
  'single malt',
  'single pot still',
  'tennessee',
]);

/**
 * The country codes the `country` table holds. `GB` is deliberately absent
 * from what a producer may claim: the pipeline treats it as an umbrella and
 * drops it, so a producer row asserting it would state nothing.
 */
const COUNTRIES = new Set([
  'AM',
  'AT',
  'AU',
  'AZ',
  'BE',
  'BG',
  'CA',
  'CH',
  'CU',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB-ENG',
  'GB-SCT',
  'GB-WLS',
  'GE',
  'GR',
  'HR',
  'HU',
  'IE',
  'IL',
  'IN',
  'IT',
  'JP',
  'KZ',
  'LK',
  'LT',
  'LV',
  'MD',
  'MX',
  'NL',
  'NO',
  'NZ',
  'PL',
  'PT',
  'RO',
  'SE',
  'SG',
  'SI',
  'SK',
  'TR',
  'TW',
  'UA',
  'US',
  'XX',
  'ZA',
]);

/**
 * Rules that apply to every producer, authored here rather than researched.
 *
 * They are central because they are the safety net: they read what a bottling's
 * own name states, so they catch a peated expression of an unresearched
 * producer and, more importantly, they let a name overrule a house profile.
 * Leaving them to sixteen independent agents would have produced sixteen
 * slightly different spellings of the same rule.
 *
 * Priorities are load-bearing. A negation sits above everything, so
 * `Benromach Unpeated` beats Benromach's own light profile. The qualified forms
 * sit above the bare keyword, so `Mac-Talla Flora Lightly Peated` is light
 * rather than heavy — a real catalogue row that the bare rule would over-state.
 */
const GLOBAL_RULES: KbRuleRow[] = [
  rule('unpeated', PeatProfile.NONE, 100),
  rule('non peated', PeatProfile.NONE, 100),
  rule('not peated', PeatProfile.NONE, 100),
  {
    ...rule('неторф', PeatProfile.NONE, 100),
    matchMode: FlavorRuleMatchMode.PREFIX,
    note: 'Ukrainian negation, inflected',
  },
  rule('heavily peated', PeatProfile.HEAVY, 60),
  rule('lightly peated', PeatProfile.LIGHT, 60),
  rule('peated', PeatProfile.HEAVY, 50),
  rule('peaty', PeatProfile.HEAVY, 50),
  rule('peat', PeatProfile.HEAVY, 50),
  {
    ...rule('торф', PeatProfile.HEAVY, 50),
    matchMode: FlavorRuleMatchMode.PREFIX,
    note: 'Ukrainian for peated, inflected',
  },
  /**
   * Smoke words state smokiness, never peat. That split is the product
   * decision behind the whole vocabulary: `Grant's Triple Wood Smoky` and
   * `Smoky Black The Famous Grouse` are smoky blends with no peat, and tagging
   * them peated is what made the owner's exclusion filter untrustworthy.
   */
  tagRule('smoky', 'smoky', 40),
  tagRule('smokey', 'smoky', 40),
  tagRule('smoke', 'smoky', 40),
  {
    ...tagRule('димн', 'smoky', 40),
    matchMode: FlavorRuleMatchMode.PREFIX,
    note: 'Ukrainian for smoky, inflected',
  },
  tagRule('sherry cask', 'sherry', 20),
  tagRule('sherry casks', 'sherry', 20),
  tagRule('sherry finish', 'sherry', 20),
  tagRule('sherry wood', 'sherry', 20),
  tagRule('oloroso', 'sherry', 20),
  tagRule('pedro ximenez', 'sherry', 20),
  tagRule('amontillado', 'sherry', 20),
  /**
   * `bourbon` alone is deliberately not a rule: it heads a cask qualifier far
   * more often than it names a category, and stripping it once collided
   * `Bushmills Bourbon Finish` with `Bushmills Rum Finish`.
   */
  tagRule('bourbon cask', 'bourbon-cask', 20),
  tagRule('bourbon casks', 'bourbon-cask', 20),
  tagRule('bourbon barrel', 'bourbon-cask', 20),
  tagRule('ex bourbon', 'bourbon-cask', 20),
  tagRule('virgin oak', 'oak', 20),
  tagRule('charred oak', 'oak', 20),
];

/**
 * Builds a global peat rule.
 *
 * @param pattern - The raw pattern; normalized on write.
 * @param peatProfile - The level the pattern implies.
 * @param priority - Higher wins among matching peat rules.
 * @returns The rule row.
 */
function rule(
  pattern: string,
  peatProfile: PeatProfile,
  priority: number,
): KbRuleRow {
  return {
    producerSlug: '',
    pattern,
    matchMode: FlavorRuleMatchMode.WORD,
    flavor: '',
    effect: '',
    peatProfile,
    priority,
    sourceUrls: '',
    note: '',
  };
}

/**
 * Builds a global tag rule.
 *
 * @param pattern - The raw pattern; normalized on write.
 * @param flavor - The tag the pattern requires.
 * @param priority - Rule priority.
 * @returns The rule row.
 */
function tagRule(
  pattern: string,
  flavor: string,
  priority: number,
): KbRuleRow {
  return {
    producerSlug: '',
    pattern,
    matchMode: FlavorRuleMatchMode.WORD,
    flavor,
    effect: KbFlavorEffect.REQUIRE,
    peatProfile: '',
    priority,
    sourceUrls: '',
    note: '',
  };
}

/**
 * Splits a TSV file into rows of fields, skipping blanks and comments.
 *
 * @param path - File to read; a missing file yields no rows, since an agent
 *   with nothing to say for a shape legitimately writes an empty file.
 * @param fields - How many fields each row must have.
 * @param report - Where to record malformed rows.
 * @param origin - Which agent produced the file, for the report.
 * @returns The parsed rows.
 */
function readTsv(
  path: string,
  fields: number,
  report: KbMergeReport,
  origin: string,
): string[][] {
  if (!existsSync(path)) {
    return [];
  }

  const rows: string[][] = [];

  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim() || line.startsWith('#')) {
      return;
    }

    const parts = line.split('\t').map((part) => part.trim());

    /**
     * A trailing empty field is routinely lost when a file is hand-edited, so
     * a short row is padded rather than rejected. A long one is a real
     * structural error — most likely a tab inside a value — and is dropped,
     * because importing it would silently shift every field after the tab.
     */
    while (parts.length < fields) {
      parts.push('');
    }

    if (parts.length > fields) {
      report.rejected.push(
        `${origin}:${index + 1} has ${parts.length} fields, expected ${fields}`,
      );

      return;
    }

    rows.push(parts);
  });

  return rows;
}

/**
 * Validates one producer row, collecting every problem rather than the first.
 *
 * @param row - The parsed row.
 * @param origin - Which agent produced it.
 * @returns The problems found; empty means the row is usable.
 */
function checkProducer(row: KbProducerRow, origin: string): string[] {
  const problems: string[] = [];
  const where = `${origin}:${row.slug || '(no slug)'}`;

  if (!row.slug || !/^[a-z0-9-]+$/.test(row.slug)) {
    problems.push(`${where} slug is missing or not kebab-case`);
  }

  if (!row.name) {
    problems.push(`${where} has no display name`);
  }

  if (!Object.values(ProducerKind).includes(row.kind as ProducerKind)) {
    problems.push(`${where} kind '${row.kind}' is not a ProducerKind`);
  }

  if (row.countryCode && !COUNTRIES.has(row.countryCode)) {
    problems.push(`${where} country '${row.countryCode}' is unknown`);
  }

  if (
    row.region
    && !Object.values(ScotlandRegion).includes(row.region as ScotlandRegion)
  ) {
    problems.push(`${where} region '${row.region}' is not a ScotlandRegion`);
  }

  if (
    row.legalRegion
    && !Object.values(ScotlandLegalRegion)
      .includes(row.legalRegion as ScotlandLegalRegion)
  ) {
    problems.push(`${where} legalRegion '${row.legalRegion}' is invalid`);
  }

  if (row.defaultTypeName && !TYPES.has(row.defaultTypeName)) {
    problems.push(`${where} type '${row.defaultTypeName}' is unknown`);
  }

  if (!Object.values(PeatProfile).includes(row.peatProfile as PeatProfile)) {
    problems.push(`${where} peatProfile '${row.peatProfile}' is invalid`);
  }

  return problems;
}

/**
 * Reduces a peat claim that carries no citation to `unknown`.
 *
 * A wrong positive removes a whisky from the owner's results without trace, so
 * a claim with nothing behind it must never be trusted. It is demoted rather
 * than rejected because rejecting the row takes its aliases down with it: an
 * own-label blend stated as `none` with no URL would stop resolving at all,
 * turning a cautious `unknown` into a hole in the catalogue. Demotion loses
 * only the claim, which is exactly what was unsupported.
 *
 * @param entry - The parsed row and the agent that produced it.
 * @param report - Where the demotion is recorded for review.
 * @returns The entry unchanged, or a copy whose peat claim is `unknown`.
 */
function demoteUncitedPeat(
  entry: { row: KbProducerRow; origin: string },
  report: KbMergeReport,
): { row: KbProducerRow; origin: string } {
  const { row, origin } = entry;

  if (row.peatProfile === PeatProfile.UNKNOWN || row.sourceUrls) {
    return entry;
  }

  report.downgraded.push(
    `${origin}:${row.slug} peat '${row.peatProfile}' -> unknown (uncited)`,
  );

  return { origin, row: { ...row, peatProfile: PeatProfile.UNKNOWN } };
}

/**
 * How much a row is worth keeping when two agents describe one producer.
 *
 * Citations count for more than a stated confidence, because confidence is
 * self-assessed and a URL is not.
 *
 * @param row - The producer row.
 * @returns A score; higher wins.
 */
function producerScore(row: KbProducerRow): number {
  const cited = row.sourceUrls ? row.sourceUrls.split(' ').length : 0;
  const confident = row.confidence === 'high' ? 2 : 0;
  const known = row.peatProfile !== PeatProfile.UNKNOWN ? 2 : 0;
  const filled = [
    row.countryCode,
    row.region,
    row.legalRegion,
    row.owner,
    row.defaultTypeName,
    row.parentSlug,
    row.bottlerSlug,
  ].filter(Boolean).length;

  return cited * 3 + confident + known + filled;
}

/**
 * Merges the sixteen agents' producer rows into one set keyed by slug.
 *
 * A slug appearing twice is expected rather than exceptional: a distillery is
 * both a brand of its own and a name inside some bottler's product titles, so
 * two agents legitimately describe it. Only a disagreement about **peat** is
 * escalated — the other fields differing is usually one agent knowing more.
 *
 * @param rows - Every producer row, with its origin.
 * @param report - Where to record conflicts.
 * @returns The winning row per slug.
 */
function mergeProducers(
  rows: { row: KbProducerRow; origin: string }[],
  report: KbMergeReport,
): Map<string, KbProducerRow> {
  const bySlug = new Map<string, { row: KbProducerRow; origin: string }>();

  rows.forEach((entry) => {
    const seen = bySlug.get(entry.row.slug);

    if (!seen) {
      bySlug.set(entry.row.slug, entry);

      return;
    }

    if (seen.row.peatProfile !== entry.row.peatProfile) {
      report.peatConflicts.push(
        `${entry.row.slug}: ${seen.origin} says ${seen.row.peatProfile}, `
          + `${entry.origin} says ${entry.row.peatProfile}`,
      );
    }

    if (producerScore(entry.row) > producerScore(seen.row)) {
      bySlug.set(entry.row.slug, entry);
    }
  });

  return new Map(
    [...bySlug.entries()].map(([slug, entry]) => [slug, entry.row]),
  );
}

/**
 * Drops references to producers no agent described.
 *
 * A dangling `parentSlug` would break the sibling arbitration silently — the
 * resolver would stop recognising that `ledaig` belongs to `tobermory` — so
 * the reference is cleared and reported rather than left to fail at import.
 *
 * @param producers - The merged producers, mutated in place.
 * @param report - Where to record the dropped references.
 * @returns Nothing.
 */
function pruneReferences(
  producers: Map<string, KbProducerRow>,
  report: KbMergeReport,
): void {
  producers.forEach((row) => {
    if (row.parentSlug && !producers.has(row.parentSlug)) {
      report.danglingRefs.push(`${row.slug} parent -> ${row.parentSlug}`);
      row.parentSlug = '';
    }

    if (row.bottlerSlug && !producers.has(row.bottlerSlug)) {
      report.danglingRefs.push(`${row.slug} bottler -> ${row.bottlerSlug}`);
      row.bottlerSlug = '';
    }
  });
}

/**
 * Normalizes and deduplicates the aliases.
 *
 * The key is normalized with the very function the resolver matches on, so a
 * spelling that survives here is one the resolver will certainly find. A short
 * alias asking to be matched inside product names is downgraded rather than
 * dropped: as an exact brand value it is still useful, and as a substring it
 * would mis-resolve — the catalogue's `Elements of Islay` beside `M&H Elements`
 * is the case that settles it.
 *
 * @param rows - Every alias row, with its origin.
 * @param producers - The merged producers, to check references against.
 * @param report - Where to record drops and downgrades.
 * @returns The winning alias per normalized key.
 */
function mergeAliases(
  rows: { row: KbAliasRow; origin: string }[],
  producers: Map<string, KbProducerRow>,
  report: KbMergeReport,
): Map<string, KbAliasRow> {
  const byKey = new Map<string, KbAliasRow>();

  rows.forEach(({ row, origin }) => {
    const key = KbKeyUtils.key(row.key);

    if (!key) {
      report.rejected.push(`${origin}: alias '${row.key}' normalizes to empty`);

      return;
    }

    /**
     * An alias that normalizes to nothing but whisky category words is
     * rejected, however long it is. This is the guard the seed round was
     * missing: a researcher wrote the alias `& Whisky` *because* it was the
     * exact catalogue string and said so in the note, and normalization then
     * deleted the ampersand and stored the bare word `whisky` — a brand-scoped
     * alias that matched goodwine's own category label and, through it,
     * fourteen bottlings. The length floor below cannot see this: `whisky` is
     * six characters, and brand scope is exempt from the floor anyway.
     */
    if (!ProductMatchUtils.carriesIdentity(key)) {
      report.rejected.push(
        `${origin}: alias '${row.key}' normalizes to the category word `
          + `'${key}'`,
      );

      return;
    }

    if (!producers.has(row.producerSlug)) {
      report.danglingRefs.push(`alias '${key}' -> ${row.producerSlug}`);

      return;
    }

    const scopes = Object.values(ProducerAliasScope) as string[];

    let scope = scopes.includes(row.scope)
      ? row.scope as ProducerAliasScope
      : ProducerAliasScope.BRAND;

    if (
      scope !== ProducerAliasScope.BRAND
      && key.length < KB_NAME_ALIAS_MIN_LENGTH
    ) {
      report.downgraded.push(`alias '${key}' -> brand scope (too short)`);
      scope = ProducerAliasScope.BRAND;
    }

    const seen = byKey.get(key);

    if (seen && seen.producerSlug !== row.producerSlug) {
      report.aliasConflicts.push(
        `'${key}': ${seen.producerSlug} vs ${row.producerSlug} (${origin})`,
      );

      return;
    }

    byKey.set(key, { key, producerSlug: row.producerSlug, scope, note: '' });
  });

  return byKey;
}

/**
 * Validates and deduplicates the house-style rows.
 *
 * A `peated` row is rejected outright. Peat has exactly one source of truth,
 * and a second one is how the two would come to disagree — which is the whole
 * defect being repaired.
 *
 * @param rows - Every flavor row, with its origin.
 * @param producers - The merged producers.
 * @param report - Where to record rejections.
 * @returns The accepted rows, one per (producer, flavor).
 */
function mergeFlavors(
  rows: { row: KbFlavorRow; origin: string }[],
  producers: Map<string, KbProducerRow>,
  report: KbMergeReport,
): KbFlavorRow[] {
  const byPair = new Map<string, KbFlavorRow>();

  rows.forEach(({ row, origin }) => {
    if (row.flavor === 'peated') {
      report.rejected.push(
        `${origin}: ${row.producerSlug} states 'peated' as a house style; `
          + 'peat comes only from peatProfile',
      );

      return;
    }

    if (!FLAVORS.has(row.flavor)) {
      report.rejected.push(`${origin}: flavor '${row.flavor}' is unknown`);

      return;
    }

    if (
      !Object.values(KbFlavorEffect).includes(row.effect as KbFlavorEffect)
    ) {
      report.rejected.push(`${origin}: effect '${row.effect}' is invalid`);

      return;
    }

    if (!producers.has(row.producerSlug)) {
      report.danglingRefs.push(`flavor -> ${row.producerSlug}`);

      return;
    }

    byPair.set(`${row.producerSlug}\t${row.flavor}`, row);
  });

  return [...byPair.values()];
}

/**
 * Validates and deduplicates the rules, global ones included.
 *
 * @param rows - Every rule row, with its origin.
 * @param producers - The merged producers.
 * @param report - Where to record rejections.
 * @returns The accepted rules, one per (producer, pattern, flavor).
 */
function mergeRules(
  rows: { row: KbRuleRow; origin: string }[],
  producers: Map<string, KbProducerRow>,
  report: KbMergeReport,
): KbRuleRow[] {
  const byKey = new Map<string, KbRuleRow>();

  rows.forEach(({ row, origin }) => {
    const pattern = KbKeyUtils.key(row.pattern);
    const isPeat = Boolean(row.peatProfile);
    const isTag = Boolean(row.flavor) && Boolean(row.effect);

    if (!pattern) {
      report.rejected.push(`${origin}: rule pattern is empty`);

      return;
    }

    if (isPeat === isTag) {
      report.rejected.push(
        `${origin}: rule '${pattern}' must be either a peat rule or a tag `
          + 'rule, never both or neither',
      );

      return;
    }

    if (
      isPeat && !Object.values(PeatProfile).includes(
        row.peatProfile as PeatProfile,
      )
    ) {
      report.rejected.push(`${origin}: rule peat '${row.peatProfile}' invalid`);

      return;
    }

    if (isTag && !FLAVORS.has(row.flavor)) {
      report.rejected.push(`${origin}: rule flavor '${row.flavor}' unknown`);

      return;
    }

    if (row.producerSlug && !producers.has(row.producerSlug)) {
      report.danglingRefs.push(`rule '${pattern}' -> ${row.producerSlug}`);

      return;
    }

    byKey.set(
      `${row.producerSlug}\t${pattern}\t${row.flavor}`,
      { ...row, pattern },
    );
  });

  return [...byKey.values()];
}

/**
 * The producer fields a reviewer may override.
 *
 * `slug` is absent on purpose — renaming a producer is what
 * {@link foldSlugs} is for, and allowing it here would leave every reference
 * pointing at a row that no longer exists.
 */
const OVERRIDABLE = new Set([
  'name',
  'kind',
  'countryCode',
  'region',
  'legalRegion',
  'owner',
  'defaultTypeName',
  'peatProfile',
  'parentSlug',
  'bottlerSlug',
  'status',
  'confidence',
  'sourceUrls',
  'note',
]);

/**
 * Rewrites every reference to a retired slug before the rows are merged.
 *
 * Folding here rather than after the merge is what makes it complete: the
 * duplicate rows collapse onto one slug, so `mergeProducers` scores them
 * against each other and keeps the better-sourced one, and the two spellings'
 * aliases stop colliding because they now name the same producer.
 *
 * @param all - Every parsed row, mutated in place by replacement.
 * @param merges - The reviewer's fold decisions.
 * @param report - Where the folds are recorded.
 * @returns Nothing.
 */
function foldSlugs(
  all: {
    producers: { row: KbProducerRow; origin: string }[];
    aliases: { row: KbAliasRow; origin: string }[];
    flavors: { row: KbFlavorRow; origin: string }[];
    rules: { row: KbRuleRow; origin: string }[];
  },
  merges: KbSlugMerge[],
  report: KbMergeReport,
): void {
  if (!merges.length) {
    return;
  }

  const target = new Map(merges.map((one) => [one.fromSlug, one.toSlug]));

  const resolve = (slug: string): string => target.get(slug) ?? slug;

  all.producers.forEach(({ row }) => {
    row.slug = resolve(row.slug);
    row.parentSlug = resolve(row.parentSlug);
    row.bottlerSlug = resolve(row.bottlerSlug);
  });

  all.aliases.forEach(({ row }) => {
    row.producerSlug = resolve(row.producerSlug);
  });

  all.flavors.forEach(({ row }) => {
    row.producerSlug = resolve(row.producerSlug);
  });

  all.rules.forEach(({ row }) => {
    row.producerSlug = resolve(row.producerSlug);
  });

  merges.forEach((one) => {
    report.curated.push(
      `fold ${one.fromSlug} -> ${one.toSlug}: ${one.note}`,
    );
  });
}

/**
 * Applies the reviewer's field overrides to the merged producers.
 *
 * @param producers - The merged producers, corrected in place.
 * @param overrides - The reviewer's decisions.
 * @param report - Where the corrections and their failures are recorded.
 * @param statusOnly - True to apply only `status` overrides, which must land
 *   after the auto-gate has had its say, false to apply everything else.
 * @returns Nothing.
 */
function applyOverrides(
  producers: Map<string, KbProducerRow>,
  overrides: KbOverride[],
  report: KbMergeReport,
  statusOnly: boolean,
): void {
  overrides
    .filter((one) => (one.field === 'status') === statusOnly)
    .forEach((one) => {
      const row = producers.get(one.slug);

      if (!row) {
        report.rejected.push(`override: no producer '${one.slug}'`);

        return;
      }

      if (!OVERRIDABLE.has(one.field)) {
        report.rejected.push(`override: field '${one.field}' is not settable`);

        return;
      }

      const before = (row as unknown as Record<string, string>)[one.field];

      (row as unknown as Record<string, string>)[one.field] = one.value;

      report.curated.push(
        `${one.slug}.${one.field}: '${before}' -> '${one.value}' (${one.note})`,
      );
    });
}

/**
 * Reads the reviewer's curation files.
 *
 * They are optional: the merge is meaningful before anyone has reviewed
 * anything, and a missing file means no decisions have been recorded yet.
 *
 * @param dir - The curation directory, or undefined when none was given.
 * @param report - Where malformed rows are recorded.
 * @returns The fold and override decisions.
 */
function readCuration(
  dir: string | undefined,
  report: KbMergeReport,
): { merges: KbSlugMerge[]; overrides: KbOverride[] } {
  if (!dir) {
    return { merges: [], overrides: [] };
  }

  const merges = readTsv(join(dir, 'merge-slugs.tsv'), 3, report, 'curation')
    .map((f) => ({ fromSlug: f[0], toSlug: f[1], note: f[2] }))
    .filter((one) => one.fromSlug && one.toSlug);

  const overrides = readTsv(join(dir, 'overrides.tsv'), 4, report, 'curation')
    .map((f) => ({ slug: f[0], field: f[1], value: f[2], note: f[3] }))
    .filter((one) => one.slug && one.field);

  return { merges, overrides };
}

/**
 * Reads one agent's four files.
 *
 * @param dir - The agent's output directory.
 * @param origin - Label used in the report.
 * @param report - Where to record malformed rows.
 * @returns The agent's parsed rows.
 */
function readAgent(dir: string, origin: string, report: KbMergeReport): {
  producers: { row: KbProducerRow; origin: string }[];
  aliases: { row: KbAliasRow; origin: string }[];
  flavors: { row: KbFlavorRow; origin: string }[];
  rules: { row: KbRuleRow; origin: string }[];
} {
  const producers = readTsv(join(dir, 'producer.tsv'), 15, report, origin)
    .map((f) => ({
      origin,
      row: {
        slug: f[0],
        name: f[1],
        kind: f[2],
        countryCode: f[3],
        region: f[4],
        legalRegion: f[5],
        owner: f[6],
        defaultTypeName: f[7],
        peatProfile: f[8],
        parentSlug: f[9],
        bottlerSlug: f[10],
        status: KbStatus.UNVERIFIED,
        confidence: f[12],
        sourceUrls: f[13],
        note: f[14],
      },
    }));

  const aliases = readTsv(join(dir, 'alias.tsv'), 4, report, origin)
    .map((f) => ({
      origin,
      row: { key: f[0], producerSlug: f[1], scope: f[2], note: f[3] },
    }));

  const flavors = readTsv(join(dir, 'flavor.tsv'), 6, report, origin)
    .map((f) => ({
      origin,
      row: {
        producerSlug: f[0],
        flavor: f[1],
        effect: f[2],
        confidence: f[3],
        sourceUrls: f[4],
        note: f[5],
      },
    }));

  const rules = readTsv(join(dir, 'rule.tsv'), 9, report, origin)
    .map((f) => ({
      origin,
      row: {
        producerSlug: f[0],
        pattern: f[1],
        matchMode: f[2] || FlavorRuleMatchMode.WORD,
        flavor: f[3],
        effect: f[4],
        peatProfile: f[5],
        priority: Number(f[6]) || 0,
        sourceUrls: f[7],
        note: f[8],
      },
    }));

  return { producers, aliases, flavors, rules };
}

/**
 * Serializes rows to a TSV file.
 *
 * @param path - Destination file.
 * @param rows - Field arrays, already ordered.
 * @returns Nothing.
 */
function writeTsv(path: string, rows: string[][]): void {
  const body = rows
    .map((row) => row.map((field) => field.replace(/[\t\n]/g, ' ')).join('\t'))
    .join('\n');

  writeFileSync(path, `${body}\n`, 'utf8');
}

/**
 * Prints the merge report.
 *
 * The counts are the least interesting part. What a reviewer needs is the peat
 * disagreements and the rejected rows: those are where the seed is either
 * wrong or about to be.
 *
 * @param report - The accumulated report.
 * @returns Nothing.
 */
function printReport(report: KbMergeReport): void {
  const section = (title: string, lines: string[]): void => {
    console.log(`\n${title}: ${lines.length}`);
    lines.slice(0, 40).forEach((line) => console.log(`  ${line}`));

    if (lines.length > 40) {
      console.log(`  ... and ${lines.length - 40} more`);
    }
  };

  section('PEAT DISAGREEMENTS (review every one)', report.peatConflicts);
  section('REJECTED ROWS', report.rejected);
  section('ALIAS COLLISIONS (dropped)', report.aliasConflicts);
  section('DANGLING REFERENCES (cleared)', report.danglingRefs);
  section('SCOPE DOWNGRADES AND UNCITED PEAT', report.downgraded);
  section('CURATION APPLIED', report.curated);
}

/**
 * Merges every agent's research into the four seed files.
 *
 * @returns Resolves once the files are written.
 */
function main(): void {
  const inDir = process.argv[2];
  const outDir = process.argv[3];

  if (!inDir || !outDir) {
    console.error(
      'usage: kb-merge <agent-output-dir> <seed-output-dir> [curation-dir]',
    );
    process.exit(1);
  }

  const report: KbMergeReport = {
    peatConflicts: [],
    rejected: [],
    aliasConflicts: [],
    danglingRefs: [],
    downgraded: [],
    curated: [],
  };

  const curation = readCuration(process.argv[4], report);

  const all = {
    producers: [] as { row: KbProducerRow; origin: string }[],
    aliases: [] as { row: KbAliasRow; origin: string }[],
    flavors: [] as { row: KbFlavorRow; origin: string }[],
    rules: [] as { row: KbRuleRow; origin: string }[],
  };

  /**
   * Every subdirectory is one agent's output. The count is discovered rather
   * than fixed at sixteen because the fleet grew: closing the input gaps — the
   * brandless products and the distilleries that appear only inside bottlers'
   * product names — added four more agents, and a hard-coded range would have
   * silently dropped their research.
   */
  const labels = readdirSync(inDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!labels.length) {
    report.rejected.push(`no agent output directories under ${inDir}`);
  }

  labels.forEach((label) => {
    const agent = readAgent(join(inDir, label), `a${label}`, report);

    all.producers.push(...agent.producers);
    all.aliases.push(...agent.aliases);
    all.flavors.push(...agent.flavors);
    all.rules.push(...agent.rules);
  });

  foldSlugs(all, curation.merges, report);

  const cited = all.producers
    .map((entry) => demoteUncitedPeat(entry, report));

  const valid = cited.filter(({ row, origin }) => {
    const problems = checkProducer(row, origin);

    report.rejected.push(...problems);

    return problems.length === 0;
  });

  const producers = mergeProducers(valid, report);

  applyOverrides(producers, curation.overrides, report, false);

  pruneReferences(producers, report);

  producers.forEach((row) => {
    row.status = KbGateUtils.status(row);
  });

  /**
   * Status lands last so a reviewer's `verified` survives the auto-gate, which
   * would otherwise recompute it back to `auto` or `unverified`.
   */
  applyOverrides(producers, curation.overrides, report, true);

  const live = [...producers.values()]
    .filter((row) => row.status === KbStatus.AUTO).length;

  const aliases = mergeAliases(all.aliases, producers, report);
  const flavors = mergeFlavors(all.flavors, producers, report);

  const rules = mergeRules(
    [
      ...GLOBAL_RULES.map((row) => ({ row, origin: 'global' })),
      ...all.rules,
    ],
    producers,
    report,
  );

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  writeTsv(
    join(outDir, 'producer.tsv'),
    [...producers.values()]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((row) => [
        row.slug,
        row.name,
        row.kind,
        row.countryCode,
        row.region,
        row.legalRegion,
        row.owner,
        row.defaultTypeName,
        row.peatProfile,
        row.parentSlug,
        row.bottlerSlug,
        row.status,
        row.confidence,
        row.sourceUrls,
        row.note,
      ]),
  );

  writeTsv(
    join(outDir, 'alias.tsv'),
    [...aliases.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((row) => [row.key, row.producerSlug, row.scope]),
  );

  writeTsv(
    join(outDir, 'producer-flavor.tsv'),
    flavors
      .sort((left, right) =>
        left.producerSlug.localeCompare(right.producerSlug)
        || left.flavor.localeCompare(right.flavor)
      )
      .map((row) => [
        row.producerSlug,
        row.flavor,
        row.effect,
        row.confidence,
        row.sourceUrls,
        row.note,
      ]),
  );

  writeTsv(
    join(outDir, 'rule.tsv'),
    rules
      .sort((left, right) =>
        right.priority - left.priority
        || left.pattern.localeCompare(right.pattern)
      )
      .map((row) => [
        row.producerSlug,
        row.pattern,
        row.matchMode,
        row.flavor,
        row.effect,
        String(row.peatProfile),
        String(row.priority),
        row.sourceUrls,
        row.note,
      ]),
  );

  console.log(`producers ${producers.size} (${live} live, rest unverified)`);
  console.log(`aliases   ${aliases.size}`);
  console.log(`flavors   ${flavors.length}`);
  console.log(`rules     ${rules.length}`);

  printReport(report);
}

main();
