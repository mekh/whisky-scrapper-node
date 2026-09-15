/**
 * Every metric name this application publishes, in one place.
 *
 * The inventory is here rather than beside each recorder so a dashboard or an
 * alert rule can be checked against the source without grepping the tree, and
 * so a rename is one edit.
 */

/**
 * Prefix carried by every metric of this application, which is what separates
 * them from the exporters' own series in the same Prometheus.
 */
export const METRIC_PREFIX = 'whisky_';

/**
 * Label naming the process a series came from. Deliberately not `instance`,
 * which Prometheus owns — a colliding label is renamed to `exported_instance`
 * and the dashboards would read neither.
 */
export const METRIC_LABEL_REPLICA = 'replica';

export const METRIC_APP_INFO = 'whisky_app_info';

export const METRIC_APP_START_TIME = 'whisky_app_start_timestamp_seconds';

export const METRIC_HTTP_REQUESTS = 'whisky_http_requests_total';

export const METRIC_HTTP_DURATION = 'whisky_http_request_duration_seconds';

export const METRIC_HTTP_IN_FLIGHT = 'whisky_http_requests_in_flight';

export const METRIC_HTTP_RESPONSE_BYTES = 'whisky_http_response_size_bytes';

export const METRIC_CACHE_OPERATIONS = 'whisky_cache_operations_total';

export const METRIC_CACHE_DURATION = 'whisky_cache_command_duration_seconds';

export const METRIC_CACHE_BUMPS = 'whisky_cache_bumps_total';

export const METRIC_CACHE_GENERATION = 'whisky_cache_generation';

export const METRIC_CACHE_DIRTY = 'whisky_cache_dirty';

export const METRIC_RATE_LIMIT_DECISIONS = 'whisky_rate_limit_decisions_total';

export const METRIC_RATE_LIMIT_FAILURES =
  'whisky_rate_limit_store_failures_total';

export const METRIC_AUTH_LOGIN_ATTEMPTS = 'whisky_auth_login_attempts_total';

export const METRIC_AUTH_THROTTLE_PENALTIES =
  'whisky_auth_throttle_penalties_total';

export const METRIC_DB_POOL_CONNECTIONS = 'whisky_db_pool_connections';

export const METRIC_DEPENDENCY_UP = 'whisky_dependency_up';

export const METRIC_DEPENDENCY_DURATION =
  'whisky_dependency_check_duration_seconds';

export const METRIC_SYNC_RUNS = 'whisky_sync_runs_total';

export const METRIC_SYNC_DURATION = 'whisky_sync_run_duration_seconds';

export const METRIC_SYNC_IN_FLIGHT = 'whisky_sync_runs_in_flight';

export const METRIC_SYNC_LAST_SUCCESS =
  'whisky_sync_last_success_timestamp_seconds';

export const METRIC_SYNC_ITEMS = 'whisky_sync_items_total';

export const METRIC_SCRAPE_PAGES = 'whisky_scrape_pages_total';

export const METRIC_SCRAPE_DETAIL_PAGES = 'whisky_scrape_detail_pages_total';

export const METRIC_SCRAPE_LISTING_INCOMPLETE =
  'whisky_scrape_listing_incomplete_total';

export const METRIC_SCRAPE_STOCK_DROP = 'whisky_scrape_stock_drop_total';

export const METRIC_SCRAPE_DEADLINE_SKIPS =
  'whisky_scrape_deadline_skips_total';

export const METRIC_LLM_REQUESTS = 'whisky_llm_requests_total';

export const METRIC_LLM_DURATION = 'whisky_llm_request_duration_seconds';

export const METRIC_LLM_TOKENS = 'whisky_llm_tokens_total';

export const METRIC_PUSH_NOTIFICATIONS = 'whisky_push_notifications_total';

export const METRIC_PUSH_DIGESTS = 'whisky_push_digests_total';

export const METRIC_CURRENCY_SYNCS = 'whisky_currency_rate_sync_total';

export const METRIC_CURRENCY_LAST_EFFECTIVE =
  'whisky_currency_rate_last_effective_timestamp_seconds';

export const METRIC_CATALOGUE_STORE_ACTIVE = 'whisky_catalogue_store_active';

/**
 * Route label for a request no route pattern matched — a 404 from the router,
 * or a malformed path. It must be a constant: labelling such a request by its
 * own path is how one caller mints unbounded series.
 */
export const METRIC_ROUTE_UNMATCHED = '__unmatched__';

/**
 * Request-duration buckets, chosen against the response-time limits this
 * project measures itself by (1 s and 2 s in `docs/LOAD-TEST-2026-09.md`) and
 * against a cached report page, which serves in tens of milliseconds.
 */
export const HTTP_DURATION_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2,
  5,
  10,
  30,
];

/**
 * Response-size buckets from an empty body up to 8 MiB: a catalogue page is
 * ~100 kB and the `/meta` payload is the largest thing served.
 */
export const HTTP_RESPONSE_BUCKETS = [
  256,
  1024,
  8192,
  65536,
  262144,
  1048576,
  4194304,
  8388608,
];

/**
 * Buckets for a cache command, which is a local round trip bounded by
 * `CACHE_READ_TIMEOUT_MS` (250 ms) — anything slower is a timeout, not a
 * measurement.
 */
export const CACHE_DURATION_BUCKETS = [
  0.0005,
  0.001,
  0.0025,
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
];

/**
 * Buckets for a store sync, which runs from under a minute to the 45-minute
 * budget a browser-tier store is given.
 */
export const SYNC_DURATION_BUCKETS = [
  10,
  30,
  60,
  120,
  300,
  600,
  1200,
  1800,
  2700,
];

/**
 * Buckets for one LLM call, whose measured batch latency is ~13 s and whose
 * configured ceiling is `LLM_TIMEOUT_MS` (120 s).
 */
export const LLM_DURATION_BUCKETS = [
  0.5,
  1,
  2.5,
  5,
  10,
  20,
  40,
  80,
  120,
];

/**
 * Buckets for a dependency probe: a healthy `PING` or `SELECT 1` is
 * sub-millisecond, and anything past a second has already failed in practice.
 */
export const DEPENDENCY_DURATION_BUCKETS = [
  0.001,
  0.005,
  0.01,
  0.05,
  0.1,
  0.5,
  1,
  5,
];
