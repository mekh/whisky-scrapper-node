import 'reflect-metadata';

import { MetricsConfig } from '../src/config/parts/metrics.config';
import {
  METRIC_APP_INFO,
  METRIC_HTTP_DURATION,
  METRIC_HTTP_IN_FLIGHT,
  METRIC_HTTP_REQUESTS,
  METRIC_LABEL_REPLICA,
} from '../src/constants/metrics.constants';
import { HttpMetricsService } from '../src/lib/metrics/http-metrics.service';
import { MetricsService } from '../src/lib/metrics/metrics.service';

const VARS = [
  'METRICS_ENABLED',
  'METRICS_DEFAULT_METRICS',
  'METRICS_TOKEN',
  'METRICS_COLLECT_INTERVAL_MS',
];

/**
 * Builds a registry with the Node defaults off, so a spec measures only what
 * it recorded and does not leave the event-loop monitor running.
 */
const build = (): MetricsService => {
  process.env.METRICS_DEFAULT_METRICS = 'false';

  return new MetricsService(new MetricsConfig());
};

beforeEach(() => {
  VARS.forEach((name) => {
    delete process.env[name];
  });
});

afterEach(() => {
  VARS.forEach((name) => {
    delete process.env[name];
  });
});

describe('MetricsService', () => {
  it('sends the exposition media type Prometheus requires', () => {
    const metrics = build();

    expect(metrics.contentType).toContain('text/plain');
    expect(metrics.contentType).toContain('version=0.0.4');

    metrics.onModuleDestroy();
  });

  it('labels every series with the replica it came from', async () => {
    const metrics = build();

    metrics.counter({ name: 'whisky_probe_total', help: 'probe' }).inc();

    const body = await metrics.render();

    expect(body).toContain(`${METRIC_LABEL_REPLICA}=`);

    metrics.onModuleDestroy();
  });

  it('publishes its identity as a gauge of 1', async () => {
    const metrics = build();
    const body = await metrics.render();

    expect(body).toMatch(new RegExp(`^${METRIC_APP_INFO}\\{.*\\} 1$`, 'm'));
    expect(body).toContain('node="v');

    metrics.onModuleDestroy();
  });

  it('returns the same metric instance when asked twice', () => {
    const metrics = build();

    const first = metrics.counter({ name: 'whisky_probe_total', help: 'a' });
    const second = metrics.counter({ name: 'whisky_probe_total', help: 'b' });

    expect(second).toBe(first);

    metrics.onModuleDestroy();
  });

  it('renders nothing at all when collection is off', async () => {
    process.env.METRICS_ENABLED = 'false';

    const metrics = new MetricsService(new MetricsConfig());

    expect(metrics.enabled).toBe(false);
    await expect(metrics.render()).resolves.toBe('');

    metrics.onModuleDestroy();
  });
});

describe('HttpMetricsService', () => {
  it('counts a finished exchange by method, route and status', async () => {
    const metrics = build();
    const http = new HttpMetricsService(metrics);

    http.started('GET');
    http.finished({
      method: 'GET',
      route: '/store/:slug',
      status: 200,
      durationSec: 0.02,
      bytes: 512,
    });

    const body = await metrics.render();

    expect(body).toContain(
      `${METRIC_HTTP_REQUESTS}{method="GET",route="/store/:slug",status="200"`,
    );
    expect(body).toContain(`${METRIC_HTTP_DURATION}_bucket`);

    metrics.onModuleDestroy();
  });

  it('returns the in-flight gauge as the response is sent', async () => {
    const metrics = build();
    const http = new HttpMetricsService(metrics);

    http.started('GET');
    http.started('GET');
    http.finished({
      method: 'GET',
      route: '/meta',
      status: 200,
      durationSec: 0.01,
      bytes: null,
    });

    const body = await metrics.render();
    const line = body
      .split('\n')
      .find((row) => row.startsWith(`${METRIC_HTTP_IN_FLIGHT}{`));

    expect(line).toBeDefined();
    expect(line?.endsWith(' 1')).toBe(true);

    metrics.onModuleDestroy();
  });

  it('records no size when the reply declared none', async () => {
    const metrics = build();
    const http = new HttpMetricsService(metrics);

    http.started('GET');
    http.finished({
      method: 'GET',
      route: '/meta',
      status: 200,
      durationSec: 0.01,
      bytes: null,
    });

    const body = await metrics.render();

    expect(body).not.toContain('whisky_http_response_size_bytes_bucket');

    metrics.onModuleDestroy();
  });

  it('records nothing while collection is off', async () => {
    process.env.METRICS_ENABLED = 'false';

    const metrics = new MetricsService(new MetricsConfig());
    const http = new HttpMetricsService(metrics);

    http.started('GET');
    http.finished({
      method: 'GET',
      route: '/meta',
      status: 200,
      durationSec: 0.01,
      bytes: 10,
    });

    await expect(metrics.render()).resolves.toBe('');

    metrics.onModuleDestroy();
  });
});
