import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';

import {
  HTTP_DURATION_BUCKETS,
  HTTP_RESPONSE_BUCKETS,
  METRIC_HTTP_DURATION,
  METRIC_HTTP_IN_FLIGHT,
  METRIC_HTTP_REQUESTS,
  METRIC_HTTP_RESPONSE_BYTES,
} from '~constants';
import type { HttpExchange } from '~types';

import { MetricsService } from './metrics.service';

/**
 * Label names shared by the request counter and its duration histogram, so a
 * rate and a quantile can be sliced the same way.
 */
const EXCHANGE_LABELS = [
  'method',
  'route',
  'status',
];

/**
 * What the API served, recorded by the Fastify hooks.
 *
 * The values come from the route pattern and the status actually sent, never
 * from a path or a body — a label drawn from request data is how one caller
 * mints unbounded series.
 */
@Injectable()
export class HttpMetricsService {
  private readonly requests: Counter<string>;

  private readonly duration: Histogram<string>;

  private readonly inFlight: Gauge<string>;

  private readonly responseBytes: Histogram<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.requests = this.metrics.counter({
      name: METRIC_HTTP_REQUESTS,
      help: 'HTTP responses sent, by method, route pattern and status.',
      labelNames: EXCHANGE_LABELS,
    });

    this.duration = this.metrics.histogram({
      name: METRIC_HTTP_DURATION,
      help: 'How long a request took, from arrival to response sent.',
      labelNames: EXCHANGE_LABELS,
      buckets: HTTP_DURATION_BUCKETS,
    });

    this.inFlight = this.metrics.gauge({
      name: METRIC_HTTP_IN_FLIGHT,
      help: 'Requests currently being served by this replica.',
      labelNames: [
        'method',
      ],
    });

    this.responseBytes = this.metrics.histogram({
      name: METRIC_HTTP_RESPONSE_BYTES,
      help: 'Response body size, by route pattern.',
      labelNames: [
        'route',
      ],
      buckets: HTTP_RESPONSE_BUCKETS,
    });
  }

  /**
   * Records that a request has arrived and is being served.
   *
   * @param method - The request method.
   */
  public started(method: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.inFlight.inc({ method });
  }

  /**
   * Records a finished exchange and clears its in-flight slot.
   *
   * @param exchange - The method, route pattern, status, duration and size.
   */
  public finished(exchange: HttpExchange): void {
    if (!this.metrics.enabled) {
      return;
    }

    const labels = {
      method: exchange.method,
      route: exchange.route,
      status: String(exchange.status),
    };

    this.inFlight.dec({ method: exchange.method });
    this.requests.inc(labels);
    this.duration.observe(labels, exchange.durationSec);

    if (exchange.bytes !== null) {
      this.responseBytes.observe({ route: exchange.route }, exchange.bytes);
    }
  }
}
