import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

import { BaseConfig } from '../base.config';

/**
 * Default OpenAI-compatible endpoint. OpenRouter fronts many providers behind
 * one key, which is what production uses; point `LLM_BASE_URL` at
 * `https://api.openai.com/v1` (or any other compatible gateway) to switch.
 */
const DEFAULT_LLM_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Default OpenRouter attribution. The name is the local one on purpose:
 * `docker-compose.yaml` defaults the deployed service to `Whisky prod`, so
 * whatever falls through to here is a run from a checkout — neither side needs
 * configuring, and neither can be mislabelled by a forgotten variable.
 */
const DEFAULT_LLM_APP_NAME = 'Whisky dev';
const DEFAULT_LLM_APP_URL = 'https://whisky.vlm.com.ua/';

@Injectable()
export class ScrapeConfig extends BaseConfig {
  @IsNumber()
  @IsPositive()
  public readonly delayMultiplier = this.asNumber('SCRAPE_DELAY_MULTIPLIER')
    ?? 1;

  @IsString()
  @IsOptional()
  public readonly llmApiKey = this.asString('LLM_API_KEY');

  @IsString()
  public readonly llmBaseUrl = this.nonEmpty('LLM_BASE_URL')
    ?? DEFAULT_LLM_BASE_URL;

  @IsString()
  @IsOptional()
  public readonly llmModel = this.asString('LLM_MODEL');

  /**
   * Attribution sent with every LLM call, as OpenRouter's `X-Title` and
   * `HTTP-Referer`. Its activity log and rankings read those two headers and
   * file everything else under `Unknown`, so the name carries the environment:
   * a local backfill run is then distinguishable from a production sync.
   * Other OpenAI-compatible gateways ignore both headers.
   */
  @IsString()
  public readonly llmAppName = this.nonEmpty('LLM_APP_NAME')
    ?? DEFAULT_LLM_APP_NAME;

  @IsString()
  public readonly llmAppUrl = this.nonEmpty('LLM_APP_URL')
    ?? DEFAULT_LLM_APP_URL;

  /**
   * Whether the model may spend tokens on reasoning. Off by default: both
   * passes are mechanical rewrites, and on a reasoning model the chain of
   * thought grows with the chunk and eats the whole completion budget before
   * a single answer token is emitted (measured: 8192/8192 tokens on a 40-item
   * chunk, empty content; with reasoning off the same chunk answers in ~350).
   */
  @IsBoolean()
  public readonly llmReasoning = this.asBoolean('LLM_REASONING') ?? false;

  /**
   * Model for the flavor-classification pass, defaulting to {@link llmModel}.
   * That pass is the one place where the answer depends on the model actually
   * knowing the bottling rather than just rewriting the input line, so it may
   * be worth a stronger (and pricier) slug than the extraction passes use.
   *
   * This is **not** an enable switch: like every pass, flavor classification
   * stays off until `LLM_API_KEY` and `LLM_MODEL` are both set.
   */
  @IsString()
  @IsOptional()
  public readonly llmFlavorModel = this.asString('LLM_FLAVOR_MODEL')
    ?? this.llmModel;

  /**
   * Reasoning switch for the flavor pass, defaulting to {@link llmReasoning}.
   * Separate because classification is the one pass where reasoning could
   * plausibly help — but read the reasoning note on `llmReasoning` first: the
   * chain of thought scales with the batch and can consume the whole completion
   * budget before the first answer token.
   */
  @IsBoolean()
  public readonly llmFlavorReasoning = this.asBoolean('LLM_FLAVOR_REASONING')
    ?? this.llmReasoning;

  /**
   * Reads a variable that has a default, treating an **empty** value as unset:
   * compose forwards a var as an empty string when the host `.env` omits it,
   * and neither an empty endpoint nor an empty app name is usable.
   *
   * @param envName - The variable to read.
   * @returns The configured value, or undefined when unset or empty.
   */
  private nonEmpty(envName: string): string | undefined {
    const value = this.asString(envName);

    return value !== undefined && value !== '' ? value : undefined;
  }
}
