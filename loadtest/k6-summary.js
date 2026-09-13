/**
 * Prints the per-step table a ladder run produces: the report percentiles
 * of both cache classes, total time beside time to first byte, with the
 * error and 429 rates — read out of the `--summary-export` JSON, where each
 * tagged threshold has left its sub-metric.
 *
 *   node loadtest/k6-summary.js <run-dir>/summary.json
 */
import { readFileSync } from 'node:fs';

const [file] = process.argv.slice(2);

if (!file) {
  console.error('usage: k6-summary.js <summary.json>');
  process.exit(1);
}

const summary = JSON.parse(readFileSync(file, 'utf8'));
const metrics = summary.metrics || {};

const REPORT = 'name:GET /report/:kind';

/**
 * Milliseconds rounded for the table, or `-` when the sub-metric is absent
 * or empty (a step that saw no request of that class).
 *
 * @param {string} key - The sub-metric key in the summary.
 * @param {string} stat - Which statistic to read.
 * @returns {string} The formatted value.
 */
function ms(key, stat) {
  const metric = metrics[key];
  const value = metric ? metric[stat] : undefined;

  return value === undefined || value === 0
    ? '-'
    : Math.round(value).toString();
}

/**
 * A rate metric as a percentage, or `-` when absent.
 *
 * @param {string} key - The sub-metric key in the summary.
 * @returns {string} The formatted percentage.
 */
function pct(key) {
  const metric = metrics[key];

  return metric && typeof metric.value === 'number'
    ? `${(metric.value * 100).toFixed(2)}%`
    : '-';
}

const stages = [
  ...new Set(
    Object.keys(metrics)
      .map((key) => /stage:([^,}]+)/.exec(key))
      .filter(Boolean)
      .map((match) => match[1]),
  ),
].sort((a, b) => Number(a) - Number(b));

const table = stages.map((stage) => {
  const hit = `${REPORT},cache:hit,stage:${stage}`;
  const miss = `${REPORT},cache:miss,stage:${stage}`;

  return {
    stage,
    'hit dur p50': ms(`http_req_duration{${hit}}`, 'med'),
    'hit dur p95': ms(`http_req_duration{${hit}}`, 'p(95)'),
    'hit ttfb p95': ms(`http_req_waiting{${hit}}`, 'p(95)'),
    'miss dur p50': ms(`http_req_duration{${miss}}`, 'med'),
    'miss dur p95': ms(`http_req_duration{${miss}}`, 'p(95)'),
    'miss ttfb p95': ms(`http_req_waiting{${miss}}`, 'p(95)'),
    failed: pct(`http_req_failed{stage:${stage}}`),
    '429': pct(`rate_limited{stage:${stage}}`),
  };
});

console.table(table);

const overall = [
  ['GET /report/:kind', `http_req_duration{${REPORT}}`],
  ['  receiving (link)', `http_req_receiving{${REPORT}}`],
  ['GET /report/history', 'http_req_duration{name:GET /report/history}'],
  ['GET /dashboard/series', 'http_req_duration{name:GET /dashboard/series}'],
  ['GET /collection', 'http_req_duration{name:GET /collection}'],
  ['GET /product/search', 'http_req_duration{name:GET /product/search}'],
  ['GET /meta', 'http_req_duration{name:GET /meta}'],
  ['POST /auth/login', 'http_req_duration{name:POST /auth/login}'],
  ['POST /auth/refresh', 'http_req_duration{name:POST /auth/refresh}'],
].map(([route, key]) => ({
  route,
  p50: ms(key, 'med'),
  p95: ms(key, 'p(95)'),
  p99: ms(key, 'p(99)'),
  max: ms(key, 'max'),
}));

console.table(overall);

const counts = {
  requests: metrics.http_reqs ? metrics.http_reqs.count : '-',
  visits: metrics.visits ? metrics.visits.count : '-',
  failed: pct('http_req_failed'),
  rate_limited: pct('rate_limited'),
  dropped_after_retry: metrics.rate_limited_dropped
    ? metrics.rate_limited_dropped.count
    : 0,
  logins: metrics.auth_logins ? metrics.auth_logins.count : 0,
  refreshes: metrics.auth_refreshes ? metrics.auth_refreshes.count : 0,
  auth_failures: metrics.auth_failures ? metrics.auth_failures.count : 0,
  checks: pct('checks'),
};

console.table([counts]);
