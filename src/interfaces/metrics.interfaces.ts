/**
 * Declaration of one metric, as `MetricsService` accepts it.
 */
export interface MetricSpec {
  /**
   * The metric's full name, taken from `~constants/metrics.constants.ts` so
   * the inventory stays in one file.
   */
  name: string;

  /**
   * The `# HELP` line Prometheus publishes. Written for whoever reads the
   * exposition without this source to hand.
   */
  help: string;

  /**
   * Label names this metric carries. Every value must be drawn from a closed
   * set — a route pattern, an enum member, a store slug — never from request
   * data, which is how a label mints unbounded series.
   */
  labelNames?: string[];
}

/**
 * Declaration of a histogram, which additionally fixes its buckets.
 */
export interface HistogramSpec extends MetricSpec {
  /**
   * Upper bounds, in the metric's own unit. Changing them on a live series
   * makes the old and new observations incomparable, so they are constants.
   */
  buckets: number[];
}

/**
 * One finished HTTP exchange, as the Fastify hook reports it.
 */
export interface HttpExchange {
  /**
   * The request method, upper-cased.
   */
  method: string;

  /**
   * The **registered route pattern** (`/store/:slug`), never the raw path —
   * or `METRIC_ROUTE_UNMATCHED` when no route matched.
   */
  route: string;

  /**
   * The status actually sent, read after the exception filter has had its
   * say, so no error-to-status mapping is duplicated here.
   */
  status: number;

  /**
   * How long the exchange took, in seconds.
   */
  durationSec: number;

  /**
   * Response body size in bytes, or null when the reply declared none.
   */
  bytes: number | null;
}

/**
 * What this process publishes about itself once, as labels of a gauge whose
 * value is always 1.
 */
export interface AppInfoLabels {
  /**
   * The application version, from `package.json`.
   */
  version: string;

  /**
   * The Node runtime this replica runs on.
   */
  node: string;

  /**
   * The process id, which with the replica label identifies a container's
   * process in `docker exec`.
   */
  pid: string;
}

/**
 * The settings `MetricsConfig` resolves, as the layers that read them see it.
 */
export interface MetricsSettings {
  /**
   * Whether metrics are collected and `/metrics` answers at all. The kill
   * switch: off restores exactly the behaviour that predates them.
   */
  enabled: boolean;

  /**
   * Whether the Node runtime defaults are collected — event-loop lag, heap,
   * GC, handles. The first of those is the number this API's own ceiling was
   * diagnosed by, so it is on unless something is measurably wrong with it.
   */
  defaultMetrics: boolean;

  /**
   * Bearer token `/metrics` requires, or undefined for no check. Unset is the
   * right default for a port published nowhere; a deployment that wants the
   * endpoint closed on its private network sets it.
   */
  token?: string;

  /**
   * How often the periodic collector refreshes the gauges it owns. Never on
   * scrape: a `/metrics` handler that ran SQL would let a misconfigured
   * Prometheus put the database under load nobody asked for.
   */
  collectIntervalMs: number;
}
