import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

import { ScrapeConfig } from '~config';

import { LlmBudgetError } from './llm-budget.error';

import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

/**
 * The request body plus OpenRouter's normalized `reasoning` switch, which the
 * OpenAI type does not model. OpenRouter maps it onto whatever the upstream
 * provider actually expects, so it is the one portable way to turn a
 * reasoning model's chain of thought off.
 */
interface ChatCompletionBody extends ChatCompletionCreateParamsNonStreaming {
  reasoning?: { enabled: boolean };
}

/**
 * Shared transport for the LLM passes: one OpenAI-compatible chat-completions
 * call that is expected to answer with a JSON array.
 *
 * The endpoint is configurable (`LLM_BASE_URL`) so the same code runs against
 * OpenRouter, OpenAI, or any other compatible gateway; the model is whatever
 * slug that provider expects (`LLM_MODEL`). Both passes stay disabled until a
 * key and a model are configured — there is no sensible default model, since
 * the naming differs per provider.
 */
@Injectable()
export class LlmClientService {
  /**
   * Builds the error for an answer that carried no content. The usual cause on
   * a reasoning model is the completion budget going entirely to the chain of
   * thought, which the bare "no content" message hid — so name the reasoning
   * spend, and mark it as a budget failure so the caller can retry smaller.
   *
   * @param completion - The answer that came back empty.
   * @returns The error to throw.
   */
  private static emptyError(completion: ChatCompletion): Error {
    const finish = completion.choices[0]?.finish_reason ?? 'unknown';
    const reasoning = completion.usage?.completion_tokens_details
      ?.reasoning_tokens ?? 0;

    if (finish !== 'length') {
      return new Error(`LLM returned no content (finish_reason=${finish})`);
    }

    return new LlmBudgetError(
      'LLM hit the completion cap before answering '
        + `(${reasoning} tokens went to reasoning). Keep reasoning off `
        + '(LLM_REASONING=false), send fewer items, or raise the cap.',
    );
  }

  /**
   * Strips the markdown code fence models like to wrap JSON in, plus any
   * prose around the array — reasoning models often narrate before answering.
   *
   * @param content - The raw message content.
   * @returns The bare JSON text.
   */
  private static unwrap(content: string): string {
    const text = content
      .trim()
      .replace(/^```(?:json)?/, '')
      .replace(/```$/, '')
      .trim();

    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');

    return start >= 0 && end > start ? text.slice(start, end + 1) : text;
  }

  private readonly config: ScrapeConfig;

  public constructor(config: ScrapeConfig) {
    this.config = config;
  }

  /**
   * Whether the LLM passes are configured (endpoint key plus model).
   *
   * @returns True when a request can be made.
   */
  public get enabled(): boolean {
    return Boolean(this.config.llmApiKey && this.config.llmModel);
  }

  /**
   * Sends one prompt and parses the JSON array it answers with.
   *
   * @param prompt - The full user prompt.
   * @param maxTokens - Upper bound on the completion length.
   * @returns The parsed array.
   * @throws {Error} When the pass is disabled, the call fails, or the answer
   *   is not a JSON array.
   */
  public async askJsonArray(
    prompt: string,
    maxTokens: number,
  ): Promise<unknown[]> {
    const { llmApiKey, llmBaseUrl, llmModel } = this.config;

    if (!llmApiKey || !llmModel) {
      throw new Error('LLM is not configured');
    }

    /**
     * `HTTP-Referer` and `X-Title` are OpenRouter's attribution pair: they
     * fill the `App` column of its activity log, which reads `Unknown`
     * without them. Any other OpenAI-compatible gateway ignores them.
     */
    const client = new OpenAI({
      apiKey: llmApiKey,
      baseURL: llmBaseUrl,
      defaultHeaders: {
        'HTTP-Referer': this.config.llmAppUrl,
        'X-Title': this.config.llmAppName,
      },
    });

    /**
     * Both passes are extraction, not composition: the answer is a function of
     * the input line, so sampling only adds churn. At the provider default a
     * re-run renamed products that had not changed, and one source name could
     * come back two ways.
     */
    const body: ChatCompletionBody = {
      model: llmModel,
      max_completion_tokens: maxTokens,
      temperature: 0,
      top_p: 1,
      messages: [{ role: 'user', content: prompt }],
    };

    if (!this.config.llmReasoning) {
      body.reasoning = { enabled: false };
    }

    const completion = await client.chat.completions.create(body);
    const content = completion.choices[0]?.message.content;

    if (!content) {
      throw LlmClientService.emptyError(completion);
    }

    const parsed = JSON.parse(
      LlmClientService.unwrap(content),
    ) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('LLM did not return a JSON array');
    }

    return parsed;
  }
}
