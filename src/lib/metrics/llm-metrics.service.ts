import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from '@prometheus-io/client';

import {
  LLM_DURATION_BUCKETS,
  METRIC_LLM_DURATION,
  METRIC_LLM_REQUESTS,
  METRIC_LLM_TOKENS,
} from '~constants';

import { MetricsService } from './metrics.service';

/**
 * Milliseconds in a second; calls are timed in milliseconds and Prometheus
 * expects seconds.
 */
const MS_PER_SEC = 1000;

/**
 * What the model passes cost.
 *
 * `completion.usage` was read only to compose an error message, so the tokens
 * a sync spends were invisible. Counting them by pass and model is direct
 * spend visibility, and the `reasoning` kind catches the failure this project
 * has already paid for once: a provider ignoring the reasoning switch and
 * burning the whole completion budget before the first answer token.
 *
 * The batch runner's retries and halvings are deliberately **not** counted:
 * it is a static generic with no injection to reach, and every failed call it
 * makes is already one `outcome="error"` here. A metric nothing feeds is
 * worse than one that does not exist.
 */
@Injectable()
export class LlmMetricsService {
  private readonly requests: Counter<string>;

  private readonly duration: Histogram<string>;

  private readonly tokens: Counter<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.requests = this.metrics.counter({
      name: METRIC_LLM_REQUESTS,
      help: 'Model calls, by pass, model and outcome.',
      labelNames: [
        'pass',
        'model',
        'outcome',
      ],
    });

    this.duration = this.metrics.histogram({
      name: METRIC_LLM_DURATION,
      help: 'How long one model call took.',
      labelNames: [
        'pass',
        'model',
      ],
      buckets: LLM_DURATION_BUCKETS,
    });

    this.tokens = this.metrics.counter({
      name: METRIC_LLM_TOKENS,
      help: 'Tokens spent, by pass, model and kind: prompt, completion or '
        + 'reasoning.',
      labelNames: [
        'pass',
        'model',
        'kind',
      ],
    });
  }

  /**
   * Records one finished model call.
   *
   * @param pass - Which pass asked: fields, names, flavors or research.
   * @param model - The provider slug that answered.
   * @param outcome - success or error.
   * @param elapsedMs - How long the call took.
   */
  public call(
    pass: string,
    model: string,
    outcome: string,
    elapsedMs: number,
  ): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.requests.inc({ pass, model, outcome });
    this.duration.observe({ pass, model }, elapsedMs / MS_PER_SEC);
  }

  /**
   * Records what one call spent.
   *
   * @param pass - Which pass asked.
   * @param model - The provider slug that answered.
   * @param usage - Prompt, completion and reasoning token counts.
   */
  public spent(
    pass: string,
    model: string,
    usage: { prompt?: number; completion?: number; reasoning?: number },
  ): void {
    if (!this.metrics.enabled) {
      return;
    }

    const kinds: [string, number | undefined][] = [
      ['prompt', usage.prompt],
      ['completion', usage.completion],
      ['reasoning', usage.reasoning],
    ];

    kinds.forEach(([kind, count]) => {
      if (count && count > 0) {
        this.tokens.inc({ pass, model, kind }, count);
      }
    });
  }
}
