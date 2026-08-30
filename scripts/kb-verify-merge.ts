import 'dotenv/config';
import 'reflect-metadata';

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KbStatus, PeatProfile } from '~enums';
import { KbGateUtils, KbKeyUtils } from '~utils';

import dataSource from '../typeorm.config';

import type {
  MergeIssue,
  QueueRow,
  VerifyLine,
} from './kb-verify-merge.interfaces';

/**
 * Where the verification round keeps its inputs and outputs.
 */
const VERIFY_DIR = join(__dirname, '..', 'docs', 'kb-research', 'verify');

/**
 * The migration the generated assets belong to. The four TSVs are written
 * beside it so `nest-cli.json`'s `migrations/**\/*.tsv` asset rule ships them
 * into `dist/migrations` for the production image.
 */
const ASSET_PREFIX = '1788030413011-kb-verification-import';

/**
 * Where the assets land.
 */
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Closed vocabularies mirrored from the research brief. The database is the
 * authority on countries, types and flavors; these cover the rest.
 */
const KINDS = ['distillery', 'brand', 'blend', 'bottler'];

const REGIONS = [
  'campbeltown',
  'highland',
  'islay',
  'lowland',
  'speyside',
  'islands',
];

const SCOPES = ['any', 'brand', 'name'];

const MATCH_MODES = ['word', 'prefix'];

const EFFECTS = ['baseline', 'require', 'forbid'];

/**
 * Shortest alias key allowed outside brand scope; mirrors
 * `KB_NAME_ALIAS_MIN_LENGTH` the way the seed alias importer does.
 */
const NAME_SCOPE_MIN_LENGTH = 5;

/**
 * The retry lane. Its rows are second, better-evidenced passes over slugs an
 * earlier batch could not finish (quota, 403 walls), so they outrank the
 * owning batch's rows instead of being dropped as stubs.
 */
const RETRY_BATCH = '20';

/**
 * Field counts per output file kind.
 */
const FIELD_COUNTS: Record<string, number> = {
  'producer.tsv': 15,
  'alias.tsv': 4,
  'flavor.tsv': 6,
  'rule.tsv': 9,
  'reject.tsv': 3,
};

/**
 * Reads one TSV file into context-tagged lines, recording a malformed line as
 * an error rather than throwing, so one bad batch is reported alongside the
 * rest instead of hiding them.
 *
 * @param batch - Batch number the file belongs to.
 * @param path - Absolute path of the file.
 * @param file - Path relative to the verify directory, for messages.
 * @param expected - Required field count per line.
 * @param issues - Sink for malformed-line errors, appended in place.
 * @returns The well-formed lines.
 */
function readTsv(
  batch: string,
  path: string,
  file: string,
  expected: number,
  issues: MergeIssue[],
): VerifyLine[] {
  const rows: VerifyLine[] = [];

  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    const fields = line.split('\t');

    if (fields.length !== expected) {
      issues.push({
        level: 'error',
        message: `${file}:${index + 1} has ${fields.length} fields, `
          + `expected ${expected}`,
      });

      return;
    }

    rows.push({ batch, file, line: index + 1, fields });
  });

  return rows;
}

/**
 * Loads the curated status overrides — the documented escape hatch for
 * evidence the auto-gate's heuristics cannot see. Three tab-separated
 * fields: slug, status (`auto` or `unverified`), reason.
 *
 * @param issues - Sink for malformed-line and bad-status errors.
 * @returns Slug to its curated status.
 */
function loadOverrides(issues: MergeIssue[]): Map<string, string> {
  const path = join(VERIFY_DIR, 'curation-overrides.tsv');
  const overrides = new Map<string, string>();

  if (!existsSync(path)) {
    return overrides;
  }

  readTsv('curation', path, 'curation-overrides.tsv', 3, issues)
    .forEach((row) => {
      const status = row.fields[1] ?? '';

      if (status !== KbStatus.AUTO && status !== KbStatus.UNVERIFIED) {
        issues.push({
          level: 'error',
          message: `curation-overrides.tsv:${row.line} status `
            + `'${status}' is not allowed (auto or unverified only)`,
        });

        return;
      }

      if (!(row.fields[2] ?? '').trim()) {
        issues.push({
          level: 'error',
          message: `curation-overrides.tsv:${row.line} has no reason`,
        });

        return;
      }

      overrides.set(row.fields[0] ?? '', status);
    });

  return overrides;
}

/**
 * Loads the queue the fleet was asked about: every input row, keyed by slug,
 * remembering which batch owns it.
 *
 * @param issues - Sink for malformed-line errors.
 * @returns Slug to its stored row and owning batch.
 */
function loadQueue(issues: MergeIssue[]): Map<string, QueueRow> {
  const queue = new Map<string, QueueRow>();
  const inDir = join(VERIFY_DIR, 'in');

  readdirSync(inDir).filter((name) => name.startsWith('batch-')).sort()
    .forEach((name) => {
      const batch = name.replace(/\D/g, '');
      const file = `in/${name}`;

      readTsv(batch, join(inDir, name), file, 18, issues).forEach((row) => {
        const slug = row.fields[0] ?? '';

        if (queue.has(slug)) {
          issues.push({
            level: 'error',
            message: `${file}:${row.line} duplicates queue slug '${slug}'`,
          });

          return;
        }

        queue.set(slug, { batch, fields: row.fields.slice(0, 15) });
      });
    });

  return queue;
}

/**
 * Loads one kind of output file from every completed batch directory.
 *
 * @param kind - File name inside each `out/NN/` directory.
 * @param issues - Sink for malformed-line errors.
 * @returns Every well-formed line, tagged with its batch.
 */
function loadOutputs(kind: string, issues: MergeIssue[]): VerifyLine[] {
  const outDir = join(VERIFY_DIR, 'out');
  const rows: VerifyLine[] = [];

  readdirSync(outDir).sort().forEach((batch) => {
    const path = join(outDir, batch, kind);

    if (!existsSync(path)) {
      return;
    }

    const file = `out/${batch}/${kind}`;
    const expected = FIELD_COUNTS[kind] ?? 0;

    rows.push(...readTsv(batch, path, file, expected, issues));
  });

  return rows;
}

/**
 * Lists the batches whose producer.tsv exists — the ones the merge may treat
 * as completed.
 *
 * @returns Batch numbers, sorted.
 */
function completedBatches(): string[] {
  const outDir = join(VERIFY_DIR, 'out');

  return readdirSync(outDir)
    .filter((batch) => existsSync(join(outDir, batch, 'producer.tsv')))
    .sort();
}

/**
 * Picks one row per producer slug out of the fleet's combined output.
 *
 * A queue slug belongs to the batch whose input file lists it; a copy of it
 * emitted by any other batch is a parent stub and is dropped. A new slug
 * (a parent or bottler the knowledge base lacked) may be emitted by several
 * batches independently; the fullest copy wins, ties broken by batch order.
 *
 * @param rows - Every producer.tsv line from every completed batch.
 * @param queue - The queue, for ownership decisions.
 * @param issues - Sink for dropped-stub warnings.
 * @returns Slug to its single surviving row.
 */
function dedupeProducers(
  rows: VerifyLine[],
  queue: Map<string, QueueRow>,
  issues: MergeIssue[],
): Map<string, VerifyLine> {
  const bySlug = new Map<string, VerifyLine>();

  rows.forEach((row) => {
    const slug = row.fields[0] ?? '';
    const owner = queue.get(slug);

    if (owner && row.batch === RETRY_BATCH) {
      if (bySlug.has(slug)) {
        issues.push({
          level: 'warn',
          message: `retry lane overrides '${slug}' `
            + `(was batch ${owner.batch})`,
        });
      }

      bySlug.set(slug, row);

      return;
    }

    if (owner && owner.batch !== row.batch) {
      issues.push({
        level: 'warn',
        message: `${row.file}:${row.line} drops stub for '${slug}' `
          + `(owned by batch ${owner.batch})`,
      });

      return;
    }

    if (owner && bySlug.get(slug)?.batch === RETRY_BATCH) {
      return;
    }

    const known = bySlug.get(slug);

    if (!known) {
      bySlug.set(slug, row);

      return;
    }

    if (owner) {
      issues.push({
        level: 'error',
        message: `${row.file}:${row.line} duplicates queue row '${slug}' `
          + 'inside its own batch',
      });

      return;
    }

    const filled = row.fields.filter(Boolean).length;
    const knownFilled = known.fields.filter(Boolean).length;

    if (filled > knownFilled) {
      bySlug.set(slug, row);
    }

    issues.push({
      level: 'warn',
      message: `new row '${slug}' emitted by batches ${known.batch} and `
        + `${row.batch}; kept the fuller copy`,
    });
  });

  return bySlug;
}

/**
 * Grades one merged row through the shared auto-gate and applies the
 * withheld-positive convention: a positive peat claim the final status
 * refuses is demoted to `unknown` on the row and recorded in the note,
 * exactly as `pnpm research-brands` stores its own withheld proposals.
 *
 * A curation override (see `curation-overrides.tsv`) replaces the gate's
 * verdict — the documented escape hatch for evidence the gate's URL
 * heuristic cannot see, such as a producer-domain citation whose URL
 * carries no slug word. Overrides are applied before the demotion, so an
 * overridden-to-auto positive keeps its level.
 *
 * @param fields - The row's 15 fields, mutated in place.
 * @param override - Curated status replacing the gate's verdict, if any.
 * @returns The status the row ships with.
 */
function gateRow(fields: string[], override?: string): KbStatus {
  const gated = KbGateUtils.status({
    slug: fields[0] ?? '',
    kind: fields[2] ?? '',
    countryCode: fields[3] ?? '',
    region: fields[4] ?? '',
    peatProfile: fields[8] ?? '',
    confidence: fields[12] ?? '',
    sourceUrls: fields[13] ?? '',
  }) as string;

  const status = override ?? gated;

  const peat = fields[8] ?? '';

  const positive = peat !== PeatProfile.UNKNOWN && peat !== PeatProfile.NONE;

  if (status === KbStatus.UNVERIFIED && positive) {
    fields[8] = PeatProfile.UNKNOWN;

    const withheld = `withheld peat proposal: ${peat}`;

    if (!(fields[14] ?? '').includes('withheld peat proposal')) {
      fields[14] = [fields[14], withheld].filter(Boolean).join('. ');
    }
  }

  fields[11] = status;

  return status as KbStatus;
}

/**
 * Validates one merged producer row against the closed vocabularies and the
 * database-backed ones.
 *
 * @param row - The row to check.
 * @param countries - Known country codes.
 * @param types - Known whisky type names.
 * @param issues - Sink for violations.
 */
function validateProducer(
  row: VerifyLine,
  countries: Set<string>,
  types: Set<string>,
  issues: MergeIssue[],
): void {
  const at = `${row.file}:${row.line}`;
  const fields = row.fields;
  const slug = fields[0] ?? '';

  if (!/^[a-z0-9-]+$/.test(slug)) {
    issues.push({ level: 'error', message: `${at} bad slug '${slug}'` });
  }

  if (!(fields[1] ?? '').trim()) {
    issues.push({ level: 'error', message: `${at} '${slug}' has no name` });
  }

  if (!KINDS.includes(fields[2] ?? '')) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' unknown kind '${fields[2] ?? ''}'`,
    });
  }

  if (fields[3] && !countries.has(fields[3])) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' unknown country '${fields[3]}'`,
    });
  }

  if (fields[4] && !REGIONS.includes(fields[4])) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' unknown region '${fields[4]}'`,
    });
  }

  const legal = fields[5] ?? '';

  if (legal && (legal === 'islands' || !REGIONS.includes(legal))) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' bad legalRegion '${legal}'`,
    });
  }

  if (fields[7] && !types.has(fields[7])) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' unknown type '${fields[7]}'`,
    });
  }

  if (!Object.values(PeatProfile).includes(fields[8] as PeatProfile)) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' unknown peat '${fields[8] ?? ''}'`,
    });
  }

  const badUrl = (fields[13] ?? '')
    .split(' ')
    .filter(Boolean)
    .find((url) => !url.startsWith('http'));

  if (badUrl) {
    issues.push({
      level: 'error',
      message: `${at} '${slug}' malformed source URL '${badUrl}'`,
    });
  }
}

/**
 * Builds the 15-field row a rejected slug ships as: the stored facts exactly
 * as they were (a verdict is not a correction), the status flipped to
 * `rejected`, and the verdict's reason and evidence in the note.
 *
 * @param stored - The queue's stored fields for the slug.
 * @param reason - The agent's verdict.
 * @param urls - The evidence URLs.
 * @returns The migration-ready row.
 */
function rejectRow(
  stored: string[],
  reason: string,
  urls: string,
): string[] {
  const fields = [...stored];

  fields[11] = KbStatus.REJECTED;
  fields[13] = urls || fields[13] || '';

  fields[14] = [
    `Rejected by the verification round: ${reason}`,
    fields[14],
  ].filter(Boolean).join('. ');

  return fields;
}

/**
 * Merges, gates and validates the fleet's alias additions.
 *
 * @param rows - Raw alias.tsv lines.
 * @param producers - Every slug the merged producer set will contain.
 * @param liveAliases - Existing alias key to owning producer slug.
 * @param issues - Sink for violations.
 * @returns Deduplicated `[key, slug, scope]` rows.
 */
function mergeAliases(
  rows: VerifyLine[],
  producers: Set<string>,
  liveAliases: Map<string, string>,
  issues: MergeIssue[],
): string[][] {
  const byKey = new Map<string, string[]>();

  rows.forEach((row) => {
    const at = `${row.file}:${row.line}`;
    const key = KbKeyUtils.key(row.fields[0] ?? '');
    const slug = row.fields[1] ?? '';
    let scope = row.fields[2] || 'any';

    if (!key) {
      issues.push({ level: 'warn', message: `${at} alias with empty key` });

      return;
    }

    if (!producers.has(slug)) {
      issues.push({
        level: 'error',
        message: `${at} alias '${key}' names unknown producer '${slug}'`,
      });

      return;
    }

    if (!SCOPES.includes(scope)) {
      issues.push({
        level: 'error',
        message: `${at} alias '${key}' unknown scope '${scope}'`,
      });

      return;
    }

    if (key.length < NAME_SCOPE_MIN_LENGTH && scope !== 'brand') {
      scope = 'brand';

      issues.push({
        level: 'warn',
        message: `${at} alias '${key}' shorter than `
          + `${NAME_SCOPE_MIN_LENGTH}, coerced to brand scope`,
      });
    }

    const owner = liveAliases.get(key);

    /**
     * An existing mapping always wins: retargeting a key that already
     * resolves is a human decision, not a merge policy. The typical case is
     * a company's product range colliding with a brand that is its own
     * producer row (River Queen is Slaur Sardet's blend, and also its own
     * queue row) — the per-brand row is this knowledge base's structure.
     */
    if (owner && owner !== slug) {
      issues.push({
        level: 'warn',
        message: `${at} alias '${key}' already resolves to '${owner}' — `
          + `addition targeting '${slug}' dropped`,
      });

      return;
    }

    if (owner === slug) {
      return;
    }

    const known = byKey.get(key);

    if (known && known[1] !== slug) {
      issues.push({
        level: 'warn',
        message: `${at} alias '${key}' also added for '${known[1] ?? ''}' — `
          + `this addition targeting '${slug}' dropped`,
      });

      return;
    }

    if (!known) {
      byKey.set(key, [key, slug, scope]);
    }
  });

  return [...byKey.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Merges and validates the fleet's house-style additions.
 *
 * @param rows - Raw flavor.tsv lines.
 * @param producers - Every slug the merged producer set will contain.
 * @param flavors - Known flavor names.
 * @param issues - Sink for violations.
 * @returns Deduplicated 6-field rows.
 */
function mergeFlavors(
  rows: VerifyLine[],
  producers: Set<string>,
  flavors: Set<string>,
  peatBySlug: Map<string, string>,
  issues: MergeIssue[],
): string[][] {
  const byPair = new Map<string, string[]>();

  rows.forEach((row) => {
    const at = `${row.file}:${row.line}`;
    const fields = [...row.fields];
    const [slug, flavor, effect] = fields;

    /**
     * A `smoky baseline` on an unpeated producer is a non-answer: the peat
     * sweep removes `smoky` wherever the resolved peat is `none`, and only
     * a `require` outranks the sweep (the documented jack-daniels
     * convention for non-peat smokiness). Left as baseline it oscillates —
     * applied by one pass, swept by the next — so it is promoted, loudly.
     */
    if (
      flavor === 'smoky'
      && effect === 'baseline'
      && peatBySlug.get(slug ?? '') === 'none'
    ) {
      fields[2] = 'require';

      issues.push({
        level: 'warn',
        message: `${at} smoky baseline on unpeated '${slug ?? ''}' promoted `
          + 'to require (only require survives the peat sweep)',
      });
    }

    if (flavor === 'peated') {
      issues.push({
        level: 'error',
        message: `${at} peated may never appear as a house style`,
      });

      return;
    }

    if (!producers.has(slug ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} flavor for unknown producer '${slug ?? ''}'`,
      });

      return;
    }

    if (!flavors.has(flavor ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} unknown flavor '${flavor ?? ''}'`,
      });

      return;
    }

    if (!EFFECTS.includes(effect ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} unknown effect '${effect ?? ''}'`,
      });

      return;
    }

    const pair = `${slug ?? ''} ${flavor ?? ''}`;

    if (!byPair.has(pair)) {
      byPair.set(pair, fields);
    }
  });

  return [...byPair.values()]
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/**
 * Merges and validates the fleet's name-pattern rules, normalizing every
 * pattern to the key form the resolver matches on.
 *
 * @param rows - Raw rule.tsv lines.
 * @param producers - Every slug the merged producer set will contain.
 * @param flavors - Known flavor names.
 * @param issues - Sink for violations.
 * @returns Deduplicated 9-field rows with normalized patterns.
 */
function mergeRules(
  rows: VerifyLine[],
  producers: Set<string>,
  flavors: Set<string>,
  issues: MergeIssue[],
): string[][] {
  const byKey = new Map<string, string[]>();

  rows.forEach((row) => {
    const at = `${row.file}:${row.line}`;
    const fields = [...row.fields];
    const slug = fields[0] ?? '';
    const pattern = KbKeyUtils.key(fields[1] ?? '');
    const isPeat = Boolean(fields[5]);
    const isTag = Boolean(fields[3]) && Boolean(fields[4]);

    fields[1] = pattern;

    if (!producers.has(slug)) {
      issues.push({
        level: 'error',
        message: `${at} rule for unknown producer '${slug}'`,
      });

      return;
    }

    if (!pattern) {
      issues.push({ level: 'error', message: `${at} rule with no pattern` });

      return;
    }

    if (isPeat === isTag) {
      issues.push({
        level: 'error',
        message: `${at} rule must be peat or tag, never both or neither`,
      });

      return;
    }

    if (isPeat && !['none', 'light', 'medium', 'heavy'].includes(fields[5]!)) {
      issues.push({
        level: 'error',
        message: `${at} rule peat '${fields[5] ?? ''}' is not a level`,
      });

      return;
    }

    /**
     * A positive peat rule is held to the round's own evidence bar: no
     * opened source, no rule. A bare "peated" in a product name is caught
     * by the global keyword rules anyway, so dropping an unsourced rule
     * costs precision, never coverage.
     */
    if (isPeat && fields[5] !== 'none' && !(fields[7] ?? '').trim()) {
      issues.push({
        level: 'warn',
        message: `${at} positive peat rule for '${slug}' has no source — `
          + 'dropped',
      });

      return;
    }

    if (isTag && fields[3] === 'peated') {
      issues.push({
        level: 'error',
        message: `${at} peated may never be a rule tag`,
      });

      return;
    }

    if (isTag && !flavors.has(fields[3] ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} unknown rule flavor '${fields[3] ?? ''}'`,
      });

      return;
    }

    if (isTag && !EFFECTS.includes(fields[4] ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} unknown rule effect '${fields[4] ?? ''}'`,
      });

      return;
    }

    if (!MATCH_MODES.includes(fields[2] ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} unknown matchMode '${fields[2] ?? ''}'`,
      });

      return;
    }

    if (!/^\d+$/.test(fields[6] ?? '')) {
      issues.push({
        level: 'error',
        message: `${at} rule priority '${fields[6] ?? ''}' is not a number`,
      });

      return;
    }

    const key = `${slug} ${pattern} ${fields[3] ?? ''}`;

    if (!byKey.has(key)) {
      byKey.set(key, fields);
    }
  });

  return [...byKey.values()]
    .sort((a, b) =>
      (a[0] ?? '').localeCompare(b[0] ?? '')
      || (a[1] ?? '').localeCompare(b[1] ?? '')
    );
}

/**
 * Writes one asset file next to the migration.
 *
 * @param suffix - Asset kind (producer, alias, flavor, rule).
 * @param rows - The rows to write.
 */
function writeAsset(suffix: string, rows: string[][]): void {
  const path = join(MIGRATIONS_DIR, `${ASSET_PREFIX}.${suffix}.tsv`);

  const body = rows.map((fields) => fields.join('\t')).join('\n');

  writeFileSync(path, body.length ? `${body}\n` : '');
}

/**
 * Runs the merge.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const allowPartial = process.argv.includes('--allow-partial');
  const issues: MergeIssue[] = [];

  const queue = loadQueue(issues);
  const batches = completedBatches();

  const pending = [
    ...new Set(
      [...queue.values()].map((row) => row.batch),
    ),
  ].filter((batch) => !batches.includes(batch)).sort();

  if (pending.length) {
    issues.push({
      level: allowPartial ? 'warn' : 'error',
      message: `batches not completed yet: ${pending.join(', ')}`,
    });
  }

  await dataSource.initialize();

  try {
    const countries = new Set(
      (await dataSource.query(
        'SELECT code FROM country',
      ) as { code: string }[]).map((row) => row.code),
    );

    const types = new Set(
      (await dataSource.query(
        'SELECT name FROM type',
      ) as { name: string }[]).map((row) => row.name),
    );

    const flavors = new Set(
      (await dataSource.query(
        'SELECT name FROM flavor',
      ) as { name: string }[]).map((row) => row.name),
    );

    const liveAliases = new Map(
      (await dataSource.query(
        `SELECT a.key, p.slug
         FROM producer_alias a
         JOIN producer p ON p.id = a."producerId"`,
      ) as { key: string; slug: string }[])
        .map((row) => [row.key, row.slug]),
    );

    const dbSlugs = new Set(
      (await dataSource.query(
        'SELECT slug FROM producer',
      ) as { slug: string }[]).map((row) => row.slug),
    );

    const producerLines = loadOutputs('producer.tsv', issues);
    const rejectLines = loadOutputs('reject.tsv', issues);
    const merged = dedupeProducers(producerLines, queue, issues);

    /**
     * A slug both verified and rejected by its own batch is a contradiction
     * the agent's self-check should have caught; refuse to pick a side.
     */
    rejectLines.forEach((row) => {
      const slug = row.fields[0] ?? '';

      if (merged.has(slug) && row.batch === RETRY_BATCH) {
        issues.push({
          level: 'warn',
          message: `retry lane rejects '${slug}' — batch `
            + `${merged.get(slug)?.batch ?? ''} row dropped`,
        });

        merged.delete(slug);
      } else if (merged.has(slug)) {
        issues.push({
          level: 'error',
          message: `${row.file}:${row.line} '${slug}' is in both `
            + 'producer.tsv and reject.tsv',
        });
      }

      if (!queue.has(slug)) {
        issues.push({
          level: 'error',
          message: `${row.file}:${row.line} rejects unknown slug '${slug}'`,
        });
      }
    });

    /**
     * Coverage: every queue row of a completed batch must be answered.
     */
    const rejected = new Set(
      rejectLines.map((row) => row.fields[0] ?? ''),
    );

    queue.forEach((row, slug) => {
      const answered = merged.has(slug) || rejected.has(slug);

      if (batches.includes(row.batch) && !answered) {
        issues.push({
          level: 'error',
          message: `batch ${row.batch} left queue slug '${slug}' unanswered`,
        });
      }
    });

    const counts = { auto: 0, unverified: 0, rejected: rejected.size };

    const overrides = loadOverrides(issues);

    merged.forEach((row) => {
      validateProducer(row, countries, types, issues);

      const slug = row.fields[0] ?? '';
      const gated = gateRow(row.fields, overrides.get(slug));

      if (overrides.has(slug)) {
        issues.push({
          level: 'warn',
          message: `curation override: '${slug}' -> ${gated}`,
        });

        overrides.delete(slug);
      }

      counts[gated === KbStatus.AUTO ? 'auto' : 'unverified'] += 1;
    });

    overrides.forEach((status, slug) => {
      issues.push({
        level: 'error',
        message: `curation override for unknown slug '${slug}' (${status})`,
      });
    });

    const producerRows = [...merged.values()].map((row) => row.fields);

    rejectLines.forEach((row) => {
      const stored = queue.get(row.fields[0] ?? '');

      if (stored) {
        producerRows.push(
          rejectRow(stored.fields, row.fields[1] ?? '', row.fields[2] ?? ''),
        );
      }
    });

    producerRows.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

    const producerSlugs = new Set([
      ...producerRows.map((fields) => fields[0] ?? ''),
      ...dbSlugs,
    ]);

    const aliasRows = mergeAliases(
      loadOutputs('alias.tsv', issues),
      producerSlugs,
      liveAliases,
      issues,
    );

    const peatBySlug = new Map<string, string>(
      (await dataSource.query(
        'SELECT slug, "peatProfile" AS peat FROM producer',
      ) as { slug: string; peat: string }[])
        .map((row) => [row.slug, row.peat]),
    );

    producerRows.forEach((fields) => {
      peatBySlug.set(fields[0] ?? '', fields[8] ?? '');
    });

    const flavorRows = mergeFlavors(
      loadOutputs('flavor.tsv', issues),
      producerSlugs,
      flavors,
      peatBySlug,
      issues,
    );

    const ruleRows = mergeRules(
      loadOutputs('rule.tsv', issues),
      producerSlugs,
      flavors,
      issues,
    );

    /**
     * Dangling parent and bottler references are dropped by the migration's
     * link pass exactly as the seed importer drops them; surface them here so
     * the drop is a decision, not a surprise.
     */
    producerRows.forEach((fields) => {
      [fields[9], fields[10]].filter(Boolean).forEach((ref) => {
        if (!producerSlugs.has(ref ?? '')) {
          issues.push({
            level: 'warn',
            message: `'${fields[0] ?? ''}' references unknown `
              + `producer '${ref ?? ''}' (link will be dropped)`,
          });
        }
      });
    });

    const errors = issues.filter((issue) => issue.level === 'error');
    const warns = issues.filter((issue) => issue.level === 'warn');

    const report = [
      '# Verification merge report',
      '',
      `Generated by \`pnpm kb-verify-merge\` on ${new Date().toISOString()}.`,
      '',
      `- queue: ${queue.size} rows in ${
        new Set([...queue.values()].map((row) => row.batch)).size
      } batches`,
      `- completed batches: ${batches.join(', ') || 'none'}`,
      `- pending batches: ${pending.join(', ') || 'none'}`,
      `- producer rows: ${producerRows.length} (gate: ${counts.auto} auto, `
      + `${counts.unverified} unverified, ${counts.rejected} rejected)`,
      `- alias additions: ${aliasRows.length}`,
      `- house-style additions: ${flavorRows.length}`,
      `- rule additions: ${ruleRows.length}`,
      '',
      `## Errors (${errors.length})`,
      '',
      ...errors.map((issue) => `- ${issue.message}`),
      '',
      `## Warnings (${warns.length})`,
      '',
      ...warns.map((issue) => `- ${issue.message}`),
      '',
    ].join('\n');

    writeFileSync(join(VERIFY_DIR, 'MERGE-REPORT.md'), report);

    console.log(report);

    if (errors.length) {
      console.error(`${errors.length} error(s) — assets NOT written`);

      return 1;
    }

    writeAsset('producer', producerRows);
    writeAsset('alias', aliasRows);
    writeAsset('flavor', flavorRows);
    writeAsset('rule', ruleRows);

    console.log(`assets written to migrations/${ASSET_PREFIX}.*.tsv`);

    return 0;
  } finally {
    await dataSource.destroy();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
