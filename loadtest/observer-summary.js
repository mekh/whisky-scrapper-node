/**
 * Folds an observer TSV into one line per ladder step, aligned with the k6
 * schedule, so the server-side counters can be read beside k6's per-step
 * percentiles.
 *
 *   node loadtest/observer-summary.js <run-dir> [stages] [stepRamp] [stepHold]
 *
 * `run-dir` holds `observer.tsv` and `started-at.txt` (written by the run
 * command); the ladder defaults to the one the README documents. Cumulative
 * counters are differenced across each step, gauges are averaged and maxed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [runDir, stagesArg, rampArg, holdArg] = process.argv.slice(2);

if (!runDir) {
  console.error('usage: observer-summary.js <run-dir> [stages] [ramp] [hold]');
  process.exit(1);
}

const STAGES = (stagesArg || '50,100,200,300,400,500,650,800,1000')
  .split(',')
  .map(Number);

const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

/**
 * Parses a k6 duration (`45s`, `2m`) into milliseconds.
 *
 * @param {string} text - The duration.
 * @returns {number} Milliseconds.
 */
function durationMs(text) {
  return [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)].reduce(
    (sum, [, value, unit]) => sum + Number(value) * UNITS[unit],
    0,
  );
}

const RAMP = durationMs(rampArg || '45s');
const HOLD = durationMs(holdArg || '2m');

const startedAt = Date.parse(
  readFileSync(path.join(runDir, 'started-at.txt'), 'utf8').trim(),
);

const [headerLine, ...rows] = readFileSync(
  path.join(runDir, 'observer.tsv'),
  'utf8',
)
  .trim()
  .split('\n');

const columns = headerLine.split('\t');

/**
 * One observer line as an object keyed by column name.
 *
 * @param {string} line - A TSV line.
 * @returns {Object} Column name to numeric value (`ts` stays a string).
 */
function parseRow(line) {
  const cells = line.split('\t');

  return Object.fromEntries(
    columns.map((name, i) => [
      name,
      name === 'ts' ? cells[i] : Number(cells[i]),
    ]),
  );
}

const samples = rows.map(parseRow).filter((row) => row.ts);

/**
 * The step a sample falls into: the hold of the step whose ramp has ended.
 * Samples taken during a ramp count toward the step being ramped to.
 *
 * @param {Object} row - A sample.
 * @returns {string} The step's user count, `before` or `down`.
 */
function stageOf(row) {
  const elapsed = Date.parse(row.ts) - startedAt;

  if (elapsed < 0) {
    return 'before';
  }

  const perStep = RAMP + HOLD;
  const index = Math.floor(elapsed / perStep);

  return index < STAGES.length ? String(STAGES[index]) : 'down';
}

/**
 * Arithmetic mean, or NaN for an empty list.
 *
 * @param {number[]} values - The values.
 * @returns {number} The mean.
 */
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * A cumulative counter's rate over the group, per second.
 *
 * @param {Object[]} group - Samples of one step, in time order.
 * @param {string} column - Counter column.
 * @returns {number} Units per second across the group's span.
 */
function ratePerSec(group, column) {
  const first = group[0];
  const last = group[group.length - 1];
  const seconds = (Date.parse(last.ts) - Date.parse(first.ts)) / 1000;

  return seconds > 0 ? (last[column] - first[column]) / seconds : NaN;
}

const groups = samples.reduce((acc, row) => {
  const key = stageOf(row);

  return acc.set(key, [...(acc.get(key) || []), row]);
}, new Map());

const table = [...groups.entries()].map(([stage, group]) => {
  const hits = group[group.length - 1].cache_hits - group[0].cache_hits;
  const misses = group[group.length - 1].cache_misses - group[0].cache_misses;

  return {
    stage,
    samples: group.length,
    pg_active_avg: mean(group.map((r) => r.pg_active)).toFixed(1),
    pg_active_max: Math.max(...group.map((r) => r.pg_active)),
    pg_waiting_max: Math.max(...group.map((r) => r.pg_waiting)),
    pg_conns_max: Math.max(...group.map((r) => r.pg_conns)),
    commits_per_s: ratePerSec(group, 'pg_xact_commit').toFixed(1),
    blks_read_per_s: ratePerSec(group, 'pg_blks_read').toFixed(0),
    cache_hit_ratio: hits + misses > 0
      ? (hits / (hits + misses)).toFixed(3)
      : '-',
    cache_ops_avg: mean(group.map((r) => r.cache_ops)).toFixed(0),
    cache_mem_mb: (Math.max(...group.map((r) => r.cache_used_mem)) / 1048576)
      .toFixed(1),
    sess_ops_avg: mean(group.map((r) => r.sess_ops)).toFixed(0),
    sess_clients_max: Math.max(...group.map((r) => r.sess_clients)),
  };
});

console.table(table);
