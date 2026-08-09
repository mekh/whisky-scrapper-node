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
  public readonly llmBaseUrl = this.readBaseUrl();

  @IsString()
  @IsOptional()
  public readonly llmModel = this.asString('LLM_MODEL');

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
   * Reads the endpoint, falling back to the default. An **empty** value counts
   * as unset: compose forwards the var as an empty string when the host `.env`
   * omits it, and an empty base URL is not a usable endpoint.
   *
   * @returns The OpenAI-compatible base URL to call.
   */
  private readBaseUrl(): string {
    const value = this.asString('LLM_BASE_URL');

    return value !== undefined && value !== ''
      ? value
      : DEFAULT_LLM_BASE_URL;
  }
}
