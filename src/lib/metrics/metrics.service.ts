import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from '@prometheus-io/client';

import { MetricsConfig } from '~config';
import {
  METRIC_APP_INFO,
  METRIC_APP_START_TIME,
  METRIC_LABEL_REPLICA,
} from '~constants';
import type { HistogramSpec, MetricSpec } from '~types';

/**
 * Value published when the version cannot be read, which is honest rather
 * than a guess: a wrong version on a dashboard is worse than a missing one.
 */
const UNKNOWN_VERSION = 'unknown';

/**
 * Milliseconds in a second, for the start-time gauge Prometheus expects in
 * seconds.
 */
const MS_PER_SEC = 1000;

/**
 * The Prometheus registry of this process, and the only file that touches the
 * client library.
 *
 * Everything else asks for a metric through `counter`/`gauge`/`histogram` and
 * records into it, so swapping the library is one file and the layering rule
 * that `lib/` wraps external infrastructure holds.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  /**
   * Names the process a series came from, readably enough to find the
   * container. Under compose this is the container's own host name, which is
   * what `docker ps` shows.
   *
   * @returns The replica label value.
   */
  private static replica(): string {
    return hostname();
  }

  /**
   * Reads the application version from the `package.json` beside the running
   * code, which both the container (`/app`) and a local run have as their
   * working directory.
   *
   * @returns The version, or a marker when it cannot be read.
   */
  private static version(): string {
    try {
      const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: string };

      return parsed.version ?? UNKNOWN_VERSION;
    } catch {
      return UNKNOWN_VERSION;
    }
  }

  private readonly logger = new Logger(MetricsService.name);

  private readonly registry = new Registry();

  public constructor(private readonly config: MetricsConfig) {
    this.registry.setDefaultLabels({
      [METRIC_LABEL_REPLICA]: MetricsService.replica(),
    });

    if (this.config.enabled && this.config.defaultMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }

    if (this.config.enabled) {
      this.publishIdentity();
    }
  }

  /**
   * Whether anything is collected at all.
   */
  public get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * The exposition format's media type, which the endpoint must send verbatim
   * or Prometheus refuses the scrape.
   */
  public get contentType(): string {
    return this.registry.contentType;
  }

  /**
   * Returns the counter of that name, creating it on first use.
   *
   * @param spec - The metric's name, help text and label names.
   * @returns The registered counter.
   */
  public counter(spec: MetricSpec): Counter<string> {
    const existing = this.registry.getSingleMetric(spec.name);

    if (existing) {
      return existing as Counter<string>;
    }

    return new Counter({
      name: spec.name,
      help: spec.help,
      labelNames: spec.labelNames ?? [],
      registers: [this.registry],
    });
  }

  /**
   * Returns the gauge of that name, creating it on first use.
   *
   * @param spec - The metric's name, help text and label names.
   * @returns The registered gauge.
   */
  public gauge(spec: MetricSpec): Gauge<string> {
    const existing = this.registry.getSingleMetric(spec.name);

    if (existing) {
      return existing as Gauge<string>;
    }

    return new Gauge({
      name: spec.name,
      help: spec.help,
      labelNames: spec.labelNames ?? [],
      registers: [this.registry],
    });
  }

  /**
   * Returns the histogram of that name, creating it on first use.
   *
   * @param spec - The metric's name, help text, label names and buckets.
   * @returns The registered histogram.
   */
  public histogram(spec: HistogramSpec): Histogram<string> {
    const existing = this.registry.getSingleMetric(spec.name);

    if (existing) {
      return existing as Histogram<string>;
    }

    return new Histogram({
      name: spec.name,
      help: spec.help,
      labelNames: spec.labelNames ?? [],
      buckets: spec.buckets,
      registers: [this.registry],
    });
  }

  /**
   * Renders every metric in the exposition format.
   *
   * @returns The exposition text, empty when collection is off.
   */
  public async render(): Promise<string> {
    if (!this.config.enabled) {
      return '';
    }

    return this.registry.metrics();
  }

  /**
   * Drops every registered metric, so a process that is shutting down — or a
   * test that rebuilt the module — starts from an empty registry.
   */
  public onModuleDestroy(): void {
    this.registry.clear();
  }

  /**
   * Publishes what this process is, as a gauge whose labels carry the answer
   * and whose value is always 1 — the convention Prometheus uses for
   * build information.
   */
  private publishIdentity(): void {
    const version = MetricsService.version();

    this.gauge({
      name: METRIC_APP_INFO,
      help: "Always 1; the labels carry this replica's identity.",
      labelNames: [
        'version',
        'node',
        'pid',
      ],
    }).set(
      {
        version,
        node: process.version,
        pid: String(process.pid),
      },
      1,
    );

    this.gauge({
      name: METRIC_APP_START_TIME,
      help: 'When this replica started, in seconds since the epoch.',
    }).set(Date.now() / MS_PER_SEC);

    this.logger.log('Metrics registry ready (version %s)', version);
  }
}
