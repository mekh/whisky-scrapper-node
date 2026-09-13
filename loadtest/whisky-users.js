import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * Where the API answers. `direct` mode is the API's own published port;
 * `edge` mode is the nginx origin with `/api` appended.
 */
const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:4000').replace(
  /\/+$/,
  '',
);

/**
 * Whether every user presents its own `X-Real-IP`. Only meaningful against
 * the API port — nginx overwrites the header — and it is what lets the
 * per-address auth limits see a thousand callers instead of one.
 */
const SPOOF_IP = (__ENV.SPOOF_IP || 'true') === 'true';

/**
 * The seed's output. A relative path resolves against this script's folder.
 */
const USERS_FILE = __ENV.USERS_FILE || './users.json';

const VUS = Number(__ENV.VUS || 1000);

const RAMP_UP = __ENV.RAMP_UP || '3m';

const HOLD = __ENV.HOLD || '20m';

const RAMP_DOWN = __ENV.RAMP_DOWN || '2m';

/**
 * Optional ladder of user counts, e.g. `50,100,200,400,700,1000`. Each step
 * ramps for `STEP_RAMP` and holds for `STEP_HOLD`; when set it replaces the
 * single `VUS` plateau, and every request is tagged with its step so the
 * summary states where the limits were crossed.
 */
const STAGES = (__ENV.STAGES || '')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((n) => n > 0);

const STEP_RAMP = __ENV.STEP_RAMP || '45s';

const STEP_HOLD = __ENV.STEP_HOLD || '2m';

/**
 * Longest acceptable p95 for a report the cache is expected to hold.
 */
const CACHED_MAX_MS = Number(__ENV.CACHED_MAX_MS || 1000);

/**
 * Longest acceptable p95 for a report that has to run the query.
 */
const UNCACHED_MAX_MS = Number(__ENV.UNCACHED_MAX_MS || 2000);

/**
 * Seconds a user reads between two actions, before `THINK_SCALE`.
 */
const THINK_MIN = Number(__ENV.THINK_MIN || 3);

const THINK_MAX = Number(__ENV.THINK_MAX || 12);

/**
 * Multiplies every pause. The ceiling run shrinks it instead of adding
 * users, so the population and its per-account limits stay real.
 */
const THINK_SCALE = Number(__ENV.THINK_SCALE || 1);

/**
 * Share of filter visits that use one of the handful of popular filter
 * sets; the rest draw random combinations that mostly miss the cache.
 */
const POPULAR_SHARE = Number(__ENV.POPULAR_SHARE ?? 0.6);

/**
 * Whether the writer persona runs. Off by default: the catalogue under test
 * is production, and a run that mutates preferences measures a different
 * workload.
 */
const WRITES = __ENV.WRITES === 'true';

/**
 * Share of visits that log in again with the seeded password. Zero without
 * address spoofing, where a thousand logins share one bucket.
 */
const LOGIN_SHARE = SPOOF_IP ? Number(__ENV.LOGIN_SHARE ?? 0.03) : 0;

/**
 * Refresh the access token this many seconds before it expires.
 */
const REFRESH_MARGIN_SEC = 60;

/**
 * Longest a user waits on a 429 before giving the request up.
 */
const MAX_RATE_LIMIT_WAIT_MS = 15000;

const PER_PAGE = 50;

const DASHBOARD_RANGE_DAYS = 30;

const MS_PER_DAY = 86400000;

/**
 * What a person types into the search box, one brand at a time.
 */
const SEARCH_TERMS = [
  'glenfiddich',
  'macallan',
  'jameson',
  'ardbeg',
  'lagavulin',
  'talisker',
  'laphroaig',
  'balvenie',
  'dalmore',
  'bushmills',
  'chivas',
  'johnnie',
  'highland park',
  'bowmore',
  'bunnahabhain',
  'glenlivet',
  'aberlour',
  'tomatin',
  'jack daniel',
  'monkey shoulder',
  'glenmorangie',
  'nikka',
  'redbreast',
  'kilchoman',
  'octomore',
];

/**
 * The seeded users. `open()` runs in the init context only, and the shared
 * array keeps one copy for every VU.
 */
const users = new SharedArray(
  'users',
  () => JSON.parse(open(USERS_FILE)).users,
);

/**
 * The seeded users' shared password, as a one-element shared array so the
 * file is not parsed once per VU.
 */
const seedPassword = new SharedArray('password', () => [
  JSON.parse(open(USERS_FILE)).password,
]);

/**
 * 429 is a documented outcome here and is counted separately, so it must
 * not inflate `http_req_failed`.
 */
http.setResponseCallback(
  http.expectedStatuses({ min: 200, max: 399 }, 429),
);

const rateLimited = new Rate('rate_limited');

const rateLimitWaitMs = new Trend('rate_limit_wait_ms', true);

/**
 * Steps given up because the retry after the stated wait was refused too.
 * Kept apart from `checks`, which measure whether the API answered right.
 */
const rateLimitedDropped = new Counter('rate_limited_dropped');

const visits = new Counter('visits');

const personaVisits = new Counter('persona_visits');

const authRefreshes = new Counter('auth_refreshes');

const authLogins = new Counter('auth_logins');

const authFailures = new Counter('auth_failures');

/**
 * Parses a k6 duration (`45s`, `2m`, `1h30m`) into milliseconds.
 *
 * @param {string} text - The duration.
 * @returns {number} Milliseconds.
 */
function durationMs(text) {
  const units = { h: 3600000, m: 60000, s: 1000, ms: 1 };

  return [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)].reduce(
    (sum, [, value, unit]) => sum + Number(value) * units[unit],
    0,
  );
}

/**
 * The scenario's stages: the ladder when `STAGES` is set, else one plateau.
 *
 * @returns {Object[]} k6 `ramping-vus` stages.
 */
function buildStages() {
  if (!STAGES.length) {
    return [
      { duration: RAMP_UP, target: VUS },
      { duration: HOLD, target: VUS },
      { duration: RAMP_DOWN, target: 0 },
    ];
  }

  return STAGES.flatMap((target) => [
    { duration: STEP_RAMP, target },
    { duration: STEP_HOLD, target },
  ]).concat([{ duration: RAMP_DOWN, target: 0 }]);
}

const stages = buildStages();

/**
 * The stages as absolute offsets from the scenario's start, each labelled
 * with the user count it ramps to or holds; the ramp-down is `down`.
 */
const SCHEDULE = stages.reduce((acc, stage) => {
  const start = acc.length ? acc[acc.length - 1].end : 0;
  const label = stage.target === 0 ? 'down' : String(stage.target);

  return [...acc, { start, end: start + durationMs(stage.duration), label }];
}, []);

const STAGE_LABELS = [...new Set(SCHEDULE.map((s) => s.label))].filter(
  (label) => label !== 'down',
);

/**
 * Thresholds per step: the two report classes against their limits, on
 * both total time and time to first byte, plus errors and 429s. They exist
 * as much for the summary as for pass/fail — a tagged threshold is what
 * makes k6 print that sub-metric.
 *
 * @returns {Object} Threshold map.
 */
function stageThresholds() {
  return Object.fromEntries(
    STAGE_LABELS.flatMap((stage) => [
      [
        `http_req_duration{name:GET /report/:kind,cache:hit,stage:${stage}}`,
        [`p(95)<${CACHED_MAX_MS}`],
      ],
      [
        `http_req_duration{name:GET /report/:kind,cache:miss,stage:${stage}}`,
        [`p(95)<${UNCACHED_MAX_MS}`],
      ],
      [
        `http_req_waiting{name:GET /report/:kind,cache:hit,stage:${stage}}`,
        [`p(95)<${CACHED_MAX_MS}`],
      ],
      [
        `http_req_waiting{name:GET /report/:kind,cache:miss,stage:${stage}}`,
        [`p(95)<${UNCACHED_MAX_MS}`],
      ],
      [
        `http_req_receiving{name:GET /report/:kind,stage:${stage}}`,
        [`p(95)<${CACHED_MAX_MS}`],
      ],
      [`http_reqs{stage:${stage}}`, ['count>0']],
      [`http_req_failed{stage:${stage}}`, ['rate<0.01']],
      [`rate_limited{stage:${stage}}`, ['rate<0.01']],
    ]),
  );
}

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    /**
     * Safety valves for a production target: a collapse ends the run rather
     * than riding it out. Evaluated over the whole run, so a brief spike
     * does not trip them.
     */
    http_req_failed: [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '2m' },
    ],
    'http_req_duration{name:GET /report/:kind}': [
      {
        threshold: `p(95)<${UNCACHED_MAX_MS * 5}`,
        abortOnFail: true,
        delayAbortEval: '3m',
      },
    ],
    'http_req_duration{name:GET /report/:kind,cache:hit}': [
      `p(95)<${CACHED_MAX_MS}`,
    ],
    'http_req_duration{name:GET /report/:kind,cache:miss}': [
      `p(95)<${UNCACHED_MAX_MS}`,
    ],
    'http_req_waiting{name:GET /report/:kind,cache:hit}': [
      `p(95)<${CACHED_MAX_MS}`,
    ],
    'http_req_waiting{name:GET /report/:kind,cache:miss}': [
      `p(95)<${UNCACHED_MAX_MS}`,
    ],
    'http_req_receiving{name:GET /report/:kind}': [`p(95)<${CACHED_MAX_MS}`],
    'http_req_duration{name:GET /report/history}': [`p(95)<${UNCACHED_MAX_MS}`],
    'http_req_duration{name:GET /dashboard/series}': [
      `p(95)<${UNCACHED_MAX_MS}`,
    ],
    'http_req_duration{name:GET /collection}': [`p(95)<${UNCACHED_MAX_MS}`],
    'http_req_duration{name:GET /product/search}': ['p(95)<500'],
    'http_req_duration{name:GET /meta}': ['p(95)<500'],
    'http_req_duration{name:POST /auth/login}': [`p(95)<${UNCACHED_MAX_MS}`],
    'http_req_duration{name:POST /auth/refresh}': [`p(95)<${CACHED_MAX_MS}`],
    rate_limited: ['rate<0.01'],
    checks: ['rate>0.99'],
    ...stageThresholds(),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: { test: 'whisky-users' },
};

/**
 * The label of the step the run is in right now, from the schedule rather
 * than from the live VU count, so the ramp-down cannot pollute a lower
 * step's numbers.
 *
 * `exec.scenario` exists only inside a VU and throws anywhere else, so a
 * request issued from `setup()` — which the stale-token login path makes,
 * and which only fires when the seed predates the run by a token lifetime —
 * is labelled `setup`. It belongs to no step: no threshold names that tag,
 * so it stays out of every step's numbers instead of ending the run.
 *
 * @returns {string} A user count, `down`, or `setup`.
 */
function stageLabel() {
  let elapsed;

  try {
    elapsed = Date.now() - exec.scenario.startTime;
  } catch {
    return 'setup';
  }

  const segment = SCHEDULE.find((s) => elapsed < s.end);

  return segment ? segment.label : 'down';
}

/**
 * Per-VU state: the user this VU plays and its live tokens. A VU is one
 * JavaScript runtime, so a module-level variable is per user.
 */
let session = null;

/**
 * Draws a float in `[min, max)`.
 *
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} The draw.
 */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Draws an integer in `[min, max]`.
 *
 * @param {number} min - Lower bound, inclusive.
 * @param {number} max - Upper bound, inclusive.
 * @returns {number} The draw.
 */
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

/**
 * Picks one item at random.
 *
 * @param {Array} items - The pool.
 * @returns {*} One item, or undefined for an empty pool.
 */
function pick(items) {
  return items[randInt(0, items.length - 1)];
}

/**
 * Pauses for a reading-length think time, scaled.
 */
function think() {
  sleep(rand(THINK_MIN, THINK_MAX) * THINK_SCALE);
}

/**
 * Pauses for a keystroke-length think time, scaled.
 */
function typingPause() {
  sleep(rand(0.3, 0.6) * THINK_SCALE);
}

/**
 * Serialises a query object; arrays become CSV, undefined values are
 * skipped, which mirrors how the web client builds report URLs.
 *
 * @param {Object} query - Parameter values.
 * @returns {string} The encoded query string without the leading `?`.
 */
function qs(query) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(',') : String(value);

      return `${encodeURIComponent(key)}=${encodeURIComponent(text)}`;
    })
    .join('&');
}

/**
 * Reads the `exp` claim off an access token.
 *
 * @param {string} token - The compact JWT.
 * @returns {number} Expiry in epoch seconds, or 0 when unreadable.
 */
function tokenExp(token) {
  const payload = (token || '').split('.')[1];

  if (!payload) {
    return 0;
  }

  try {
    return JSON.parse(encoding.b64decode(payload, 'rawurl', 's')).exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Reads a response header regardless of the casing Go gave it.
 *
 * @param {Object} res - The k6 response.
 * @param {string} name - Header name, any casing.
 * @returns {string|undefined} The value.
 */
function header(res, name) {
  const wanted = name.toLowerCase();
  const key = Object.keys(res.headers).find((k) => k.toLowerCase() === wanted);

  return key ? res.headers[key] : undefined;
}

/**
 * Reads the refresh token a `Set-Cookie` header carries.
 *
 * @param {Object} res - The k6 response.
 * @returns {string|null} The cookie value, or null when none was set.
 */
function refreshCookie(res) {
  const raw = header(res, 'set-cookie');
  const text = Array.isArray(raw) ? raw.join('\n') : raw || '';
  const match = /(?:^|\n|,\s*)refresh=([^;\n]+)/.exec(text);

  return match ? match[1] : null;
}

/**
 * How long a refused request asked the caller to wait, capped.
 *
 * @param {Object} res - A 429 response.
 * @returns {number} Milliseconds to wait.
 */
function retryAfterMs(res) {
  const precise = Number(header(res, 'x-ratelimit-retry-after-ms'));
  const coarse = Number(header(res, 'retry-after')) * 1000;
  const wait = precise > 0 ? precise : coarse > 0 ? coarse : 1000;

  return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * The headers every request of this user carries.
 *
 * @param {Object} s - The VU session.
 * @param {boolean} auth - Whether to attach the bearer token.
 * @returns {Object} Header map.
 */
function headersFor(s, auth) {
  return {
    Accept: 'application/json',
    ...(SPOOF_IP ? { 'X-Real-IP': s.user.ip } : {}),
    ...(auth ? { Authorization: `Bearer ${s.access}` } : {}),
  };
}

/**
 * Resolves the user this VU plays and its tokens on the VU's first visit.
 *
 * @returns {Object} The VU session.
 */
function getSession() {
  if (!session) {
    const user = users[(exec.vu.idInTest - 1) % users.length];

    session = {
      user,
      access: user.access,
      refresh: user.refresh,
      exp: user.accessExp || tokenExp(user.access),
    };
  }

  return session;
}

/**
 * Installs a fresh token pair on the session.
 *
 * @param {Object} s - The VU session.
 * @param {Object} res - A 200 response of `/auth/login` or `/auth/refresh`.
 */
function adoptTokens(s, res) {
  const body = res.json();

  s.access = body.access;
  s.exp = tokenExp(body.access);
  s.refresh = refreshCookie(res) || s.refresh;
}

/**
 * Logs the user in again with the seeded password, as a returning visitor
 * whose refresh cookie is gone would.
 *
 * @param {Object} s - The VU session.
 * @returns {boolean} Whether the login succeeded.
 */
function login(s) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ login: s.user.name, password: seedPassword[0] }),
    {
      headers: { ...headersFor(s, false), 'Content-Type': 'application/json' },
      tags: { name: 'POST /auth/login', stage: stageLabel(), cache: 'none' },
    },
  );

  const ok = check(res, { 'login answers 200': (r) => r.status === 200 }, {
    name: 'POST /auth/login',
  });

  if (ok) {
    adoptTokens(s, res);
    authLogins.add(1);
  } else {
    authFailures.add(1, { route: 'login', status: String(res.status) });
  }

  return ok;
}

/**
 * Rotates the access token through the refresh cookie. The cookie is
 * `Secure`, which k6's jar would withhold over plain HTTP, so it is sent
 * by hand and read back from `Set-Cookie`.
 *
 * @param {Object} s - The VU session.
 * @returns {boolean} Whether the refresh succeeded.
 */
function refresh(s) {
  const res = http.post(`${BASE_URL}/auth/refresh`, null, {
    headers: { ...headersFor(s, false), Cookie: `refresh=${s.refresh}` },
    tags: { name: 'POST /auth/refresh', stage: stageLabel(), cache: 'none' },
  });

  if (res.status === 429) {
    rateLimited.add(1, { stage: stageLabel() });
    sleep(retryAfterMs(res) / 1000);

    return refresh(s);
  }

  rateLimited.add(0, { stage: stageLabel() });

  const ok = check(res, { 'refresh answers 200': (r) => r.status === 200 }, {
    name: 'POST /auth/refresh',
  });

  if (ok) {
    adoptTokens(s, res);
    authRefreshes.add(1);

    return true;
  }

  authFailures.add(1, { route: 'refresh', status: String(res.status) });

  return SPOOF_IP ? login(s) : false;
}

/**
 * Refreshes the token when it is about to expire, before a request that
 * needs it.
 *
 * @param {Object} s - The VU session.
 */
function ensureFreshToken(s) {
  const secondsLeft = s.exp - Date.now() / 1000;

  if (s.exp && secondsLeft < REFRESH_MARGIN_SEC) {
    refresh(s);
  }
}

/**
 * One authenticated request, tagged by route template, with a single retry
 * after the wait a 429 states.
 *
 * @param {Object} s - The VU session.
 * @param {string} method - HTTP method.
 * @param {string} path - Route path, without the base URL.
 * @param {string} name - Route template the metrics are tagged with.
 * @param {Object} [opts] - `query` object, JSON `body`, and `cache`: whether
 *   the answer is expected from the cache (`hit`), the query (`miss`) or is
 *   not cached at all (`none`, the default).
 * @returns {Object} The k6 response.
 */
function request(s, method, path, name, opts = {}) {
  ensureFreshToken(s);

  const url = `${BASE_URL}${path}${opts.query ? `?${qs(opts.query)}` : ''}`;
  const body = opts.body === undefined ? null : JSON.stringify(opts.body);
  const stage = stageLabel();
  const params = {
    headers: {
      ...headersFor(s, true),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    tags: { name, stage, cache: opts.cache || 'none' },
  };

  let res = http.request(method, url, body, params);

  if (res.status === 429) {
    const wait = retryAfterMs(res);

    rateLimited.add(1, { stage });
    rateLimitWaitMs.add(wait);
    sleep(wait / 1000);

    res = http.request(method, url, body, params);
  } else {
    rateLimited.add(0, { stage });
  }

  if (res.status === 429) {
    rateLimitedDropped.add(1, { name });

    return res;
  }

  check(res, { 'status is 200': (r) => r.status === 200 }, { name });

  return res;
}

/**
 * Parallel GETs, as a page load fans out. A refused request is retried on
 * its own after the stated wait.
 *
 * @param {Object} s - The VU session.
 * @param {Array<[string, Object|undefined, string, string|undefined]>} specs
 *   - Path, query, route template and cache class per request.
 * @returns {Object[]} The responses, aligned with `specs`.
 */
function batch(s, specs) {
  ensureFreshToken(s);

  const stage = stageLabel();
  const requests = specs.map(([path, query, name, cache]) => ({
    method: 'GET',
    url: `${BASE_URL}${path}${query ? `?${qs(query)}` : ''}`,
    params: {
      headers: headersFor(s, true),
      tags: { name, stage, cache: cache || 'none' },
    },
  }));

  const responses = http.batch(requests);

  return responses.map((res, i) => {
    const name = specs[i][2];

    if (res.status !== 429) {
      rateLimited.add(0, { stage });
      check(res, { 'status is 200': (r) => r.status === 200 }, { name });

      return res;
    }

    const wait = retryAfterMs(res);

    rateLimited.add(1, { stage });
    rateLimitWaitMs.add(wait);
    sleep(wait / 1000);

    const retried = http.request(
      'GET',
      requests[i].url,
      null,
      requests[i].params,
    );

    if (retried.status === 429) {
      rateLimitedDropped.add(1, { name });
    } else {
      check(retried, { 'status is 200': (r) => r.status === 200 }, { name });
    }

    return retried;
  });
}

/**
 * Parses a JSON body when the request succeeded.
 *
 * @param {Object} res - The k6 response.
 * @returns {*} The parsed body, or null.
 */
function bodyOf(res) {
  if (res.status !== 200) {
    return null;
  }

  try {
    return res.json();
  } catch {
    return null;
  }
}

/**
 * One report page, checked for the paginated envelope.
 *
 * @param {Object} s - The VU session.
 * @param {string} kind - `catalog`, `drops`, `low`, `new` or `best`.
 * @param {Object} query - Report parameters.
 * @param {string} [cache] - `hit` for a filter set the cache is expected to
 *   hold, `miss` for one it is not.
 * @returns {Object|null} The envelope, or null on failure.
 */
function report(s, kind, query, cache = 'hit') {
  const res = request(s, 'GET', `/report/${kind}`, 'GET /report/:kind', {
    query: { perPage: PER_PAGE, page: 1, ...query },
    cache,
  });

  const body = bodyOf(res);

  check(body, { 'report has data': (b) => !!b && Array.isArray(b.data) }, {
    name: 'GET /report/:kind',
    kind,
  });

  return body;
}

/**
 * What the SPA requests when the report page opens.
 *
 * @param {Object} s - The VU session.
 * @returns {Object|null} The first catalog page, for personas that need an
 *   id from it.
 */
function landing(s) {
  const responses = batch(s, [
    ['/auth/me', undefined, 'GET /auth/me'],
    ['/meta', undefined, 'GET /meta'],
    [
      '/report/catalog',
      { perPage: PER_PAGE, page: 1 },
      'GET /report/:kind',
      'hit',
    ],
    ['/preference', undefined, 'GET /preference'],
    ['/collection/ids', undefined, 'GET /collection/ids'],
    ['/quick-filter', undefined, 'GET /quick-filter'],
    ['/currency', undefined, 'GET /currency'],
    ['/currency/rate/latest', undefined, 'GET /currency/rate/latest'],
  ]);

  return bodyOf(responses[2]);
}

/**
 * Turns a page or two of the catalogue with a common sort.
 *
 * @param {Object} s - The VU session.
 */
function browsePages(s) {
  const sort = pick([
    undefined,
    { sort: 'price', order: 'asc' },
    { sort: 'price', order: 'desc' },
    { sort: 'name', order: 'asc' },
    { sort: 'discountPct', order: 'desc' },
  ]);

  const pages = randInt(2, 5);

  for (let page = 2; page <= pages; page += 1) {
    report(s, 'catalog', { ...sort, page });
    think();
  }
}

/**
 * The handful of filter sets most people reach for, built from what
 * `/meta` offers so they are always valid.
 *
 * @param {Object} meta - The setup payload.
 * @returns {Object[]} Filter sets.
 */
function popularFilters(meta) {
  const scotch = meta.countries.includes('GB-SCT') ? 'GB-SCT' : undefined;
  const malt = meta.types.find((t) => /malt/i.test(t)) || meta.types[0];

  return [
    { countries: scotch },
    { excludeFlavors: 'peated' },
    { types: malt },
    { maxPrice: 2000 },
    { minPrice: 1000, maxPrice: 3000 },
    { stores: meta.stores.slice(0, 2) },
    { excludeRegions: 'islay' },
    { regions: 'islay' },
    { flavors: 'sherry' },
    { verifiedFacts: true },
    { countries: scotch, excludeFlavors: 'peated', maxPrice: 2500 },
  ].filter((set) => Object.values(set).every((v) => v !== undefined));
}

/**
 * A random combination of one to three dimensions, which mostly produces a
 * cache key nobody has asked for yet.
 *
 * @param {Object} meta - The setup payload.
 * @returns {Object} A filter set.
 */
function randomFilters(meta) {
  const dimensions = [
    () => ({ countries: pick(meta.countries) }),
    () => ({ types: pick(meta.types) }),
    () => ({ flavors: pick(meta.flavors) }),
    () => ({ excludeFlavors: pick(meta.flavors) }),
    () => ({ stores: [pick(meta.stores), pick(meta.stores)] }),
    () => ({ regions: pick(meta.regions) }),
    () => ({ minPrice: randInt(3, 30) * 100 }),
    () => ({ maxPrice: randInt(10, 80) * 100 }),
    () => ({ minVolume: 700 }),
  ];

  const count = randInt(1, 3);

  return Array.from({ length: count }, () => pick(dimensions)()).reduce(
    (acc, part) => ({ ...acc, ...part }),
    {},
  );
}

/**
 * Applies a filter set and pages through it.
 *
 * @param {Object} s - The VU session.
 * @param {Object} meta - The setup payload.
 */
function applyFilters(s, meta) {
  const popular = Math.random() < POPULAR_SHARE;
  const filters = popular ? pick(popularFilters(meta)) : randomFilters(meta);
  const kind = pick(['catalog', 'catalog', 'catalog', 'drops', 'best']);
  const pages = randInt(1, 3);

  for (let page = 1; page <= pages; page += 1) {
    report(s, kind, { ...filters, page }, popular ? 'hit' : 'miss');
    think();
  }
}

/**
 * Types a brand into the search box, opens the matching catalogue rows and
 * one offer's price history.
 *
 * @param {Object} s - The VU session.
 */
function searchProducts(s) {
  const term = pick(SEARCH_TERMS);
  const steps = Math.min(3, Math.max(1, term.length - 2));

  for (let i = 0; i < steps; i += 1) {
    const q = term.slice(0, 3 + i);

    request(s, 'GET', '/product/search', 'GET /product/search', {
      query: { q, limit: 10 },
    });

    typingPause();
  }

  const page = report(s, 'catalog', { name: term });
  const offerId = page && page.data[0] && page.data[0].offers[0]
    ? page.data[0].offers[0].id
    : null;

  think();

  if (offerId) {
    request(s, 'GET', '/report/history', 'GET /report/history', {
      query: { term: offerId },
    });
  }
}

/**
 * Reads the deal reports the way the tabs are opened.
 *
 * @param {Object} s - The VU session.
 */
function browseDeals(s) {
  const tabs = [
    ['drops', { window: 'week', sort: 'daysDiscount', order: 'asc' }],
    ['new', { window: 'week' }],
    ['best', {}],
    ['low', { window: 'month' }],
  ];

  const count = randInt(2, 3);

  for (let i = 0; i < count; i += 1) {
    const [kind, query] = tabs[i];

    report(s, kind, query);
    think();
  }
}

/**
 * Opens the dashboard: its bounds first, then the four panels in parallel.
 *
 * @param {Object} s - The VU session.
 */
function readDashboard(s) {
  const meta = bodyOf(
    request(s, 'GET', '/dashboard/meta', 'GET /dashboard/meta'),
  );

  if (!meta || !meta.latestDate) {
    return;
  }

  const latest = new Date(meta.latestDate);
  const from = new Date(latest.getTime() - DASHBOARD_RANGE_DAYS * MS_PER_DAY);
  const floor = meta.dataFloorDate ? new Date(meta.dataFloorDate) : from;
  const range = {
    from: (from < floor ? floor : from).toISOString().slice(0, 10),
    to: meta.latestDate,
  };

  batch(s, [
    ['/dashboard/summary', range, 'GET /dashboard/summary'],
    [
      '/dashboard/series',
      { ...range, granularity: 'day' },
      'GET /dashboard/series',
    ],
    [
      '/dashboard/breakdown',
      { by: pick(['type', 'country', 'priceBucket', 'store']), date: range.to },
      'GET /dashboard/breakdown',
    ],
    ['/dashboard/movers', { ...range, limit: 20 }, 'GET /dashboard/movers'],
  ]);
}

/**
 * Opens the personal collection and its statistics.
 *
 * @param {Object} s - The VU session.
 */
function readCollection(s) {
  request(s, 'GET', '/collection', 'GET /collection');
  think();
  request(s, 'GET', '/collection/stats', 'GET /collection/stats', {
    query: { currency: pick(['UAH', 'USD', 'EUR']) },
  });
}

/**
 * Favourites one bottling, reads the favourites-only catalogue, then undoes
 * it. Runs only with `WRITES=true`.
 *
 * @param {Object} s - The VU session.
 * @param {Object|null} firstPage - The landing catalogue page.
 */
function toggleFavorite(s, firstPage) {
  const productId = firstPage && firstPage.data.length
    ? pick(firstPage.data).productId
    : null;

  if (!productId) {
    return;
  }

  request(s, 'POST', '/preference/favorites', 'POST /preference/favorites', {
    body: { productIds: [productId] },
  });
  think();
  report(s, 'catalog', { favoritesOnly: true });
  think();
  request(
    s,
    'DELETE',
    '/preference/favorites',
    'DELETE /preference/favorites',
    { body: { productIds: [productId] } },
  );
}

/**
 * A returning visitor whose cookie is gone: logs in and lands again.
 *
 * @param {Object} s - The VU session.
 */
function loginAgain(s) {
  if (login(s)) {
    think();
    request(s, 'GET', '/auth/me', 'GET /auth/me');
  }
}

const PERSONAS = [
  { name: 'browser', weight: 30, run: browsePages },
  { name: 'filterer', weight: 25, run: applyFilters },
  { name: 'searcher', weight: 15, run: searchProducts },
  { name: 'deals', weight: 15, run: browseDeals },
  { name: 'dashboard', weight: 8, run: readDashboard },
  { name: 'collector', weight: 5, run: readCollection },
  { name: 'writer', weight: WRITES ? 2 : 0, run: toggleFavorite },
  { name: 'login', weight: LOGIN_SHARE * 100, run: loginAgain },
];

/**
 * Draws a persona by weight.
 *
 * @returns {Object} The persona.
 */
function pickPersona() {
  const total = PERSONAS.reduce((sum, p) => sum + p.weight, 0);

  let roll = Math.random() * total;

  return PERSONAS.find((p) => {
    roll -= p.weight;

    return roll < 0;
  }) || PERSONAS[0];
}

/**
 * Reads `/meta` once so the filter personas draw valid values.
 *
 * @returns {Object} Store slugs, types, flavours, country codes and regions.
 */
export function setup() {
  const first = users[0];

  /**
   * The seed may predate the run by more than a token lifetime. A login opens
   * a session of its own, so the seeded one a VU will refresh stays intact.
   */
  const probe = {
    user: first,
    access: first.access,
    refresh: first.refresh,
    exp: first.accessExp || tokenExp(first.access),
  };

  if (probe.exp - Date.now() / 1000 < REFRESH_MARGIN_SEC) {
    login(probe);
  }

  const res = http.get(`${BASE_URL}/meta`, {
    headers: headersFor(probe, true),
    tags: { name: 'setup GET /meta' },
  });

  if (res.status !== 200) {
    throw new Error(
      `setup: GET ${BASE_URL}/meta answered ${res.status} — check BASE_URL `
        + 'and whether users.json was seeded against this API',
    );
  }

  const meta = res.json();

  return {
    stores: meta.stores.filter((store) => store.active).map((s) => s.slug),
    types: meta.types,
    flavors: meta.flavors,
    countries: meta.countries.map((country) => country.code),
    regions: meta.regions,
  };
}

/**
 * One visit: the page load, a think, one persona's actions, and leaving.
 *
 * @param {Object} meta - The setup payload.
 */
export default function(meta) {
  const s = getSession();

  visits.add(1);

  const firstPage = landing(s);

  think();

  const persona = pickPersona();

  personaVisits.add(1, { persona: persona.name });
  persona.run(s, persona.name === 'writer' ? firstPage : meta);

  think();
}
