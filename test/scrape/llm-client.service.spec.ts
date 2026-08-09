import 'reflect-metadata';

import { LlmClientService } from '../../src/scrape/llm/llm-client.service';

import type { ScrapeConfig } from '~config';

/**
 * The OpenAI-compatible client is replaced with a mock whose
 * `chat.completions.create` is shared across instances, so a spec can drive
 * one reply per call and assert on the request it received.
 */
const create = jest.fn();
const constructed = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((options: unknown) => {
    constructed(options);

    return { chat: { completions: { create } } };
  }),
}));

/**
 * Builds a chat-completions reply carrying the given assistant content.
 *
 * @param content - The message content the "model" returned.
 * @returns A fake completion.
 */
function reply(content: string): unknown {
  return { choices: [{ message: { content }, finish_reason: 'stop' }] };
}

function makeClient(
  over: Partial<ScrapeConfig> = {},
): LlmClientService {
  return new LlmClientService({
    llmApiKey: 'key',
    llmBaseUrl: 'https://openrouter.ai/api/v1',
    llmModel: 'openai/gpt-4o-mini',
    ...over,
  } as unknown as ScrapeConfig);
}

describe('LlmClientService', () => {
  beforeEach(() => {
    create.mockReset();
    constructed.mockReset();
  });

  it('is disabled until both a key and a model are configured', () => {
    expect(makeClient().enabled).toBe(true);
    expect(makeClient({ llmApiKey: undefined }).enabled).toBe(false);
    expect(makeClient({ llmModel: undefined }).enabled).toBe(false);
  });

  it('targets the configured endpoint and model', async () => {
    create.mockResolvedValue(reply('["a"]'));

    await makeClient().askJsonArray('prompt', 512);

    expect(constructed).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: 'https://openrouter.ai/api/v1',
    });
    expect(create).toHaveBeenCalledWith({
      model: 'openai/gpt-4o-mini',
      max_completion_tokens: 512,
      temperature: 0,
      top_p: 1,
      messages: [{ role: 'user', content: 'prompt' }],
      reasoning: { enabled: false },
    });
  });

  it('lets the model reason when explicitly enabled', async () => {
    create.mockResolvedValue(reply('["a"]'));

    await makeClient({ llmReasoning: true }).askJsonArray('prompt', 512);

    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ reasoning: expect.anything() }),
    );
  });

  it('parses a bare JSON array', async () => {
    create.mockResolvedValue(reply('["Aberlour", "Speyburn"]'));

    await expect(makeClient().askJsonArray('p', 512))
      .resolves.toEqual(['Aberlour', 'Speyburn']);
  });

  it('unwraps a fenced array', async () => {
    create.mockResolvedValue(reply('```json\n["Aberlour"]\n```'));

    await expect(makeClient().askJsonArray('p', 512))
      .resolves.toEqual(['Aberlour']);
  });

  it('unwraps an array a chatty model wrapped in prose', async () => {
    create.mockResolvedValue(
      reply('Sure! Here you go:\n["Aberlour"]\nHope that helps.'),
    );

    await expect(makeClient().askJsonArray('p', 512))
      .resolves.toEqual(['Aberlour']);
  });

  it('throws when the endpoint is not configured', async () => {
    await expect(makeClient({ llmModel: undefined }).askJsonArray('p', 512))
      .rejects.toThrow('LLM is not configured');
    expect(create).not.toHaveBeenCalled();
  });

  it('throws on an empty message', async () => {
    create.mockResolvedValue(reply(''));

    await expect(makeClient().askJsonArray('p', 512))
      .rejects.toThrow('LLM returned no content (finish_reason=stop)');
  });

  it('names the reasoning spend when the budget ran out', async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { completion_tokens_details: { reasoning_tokens: 8192 } },
    });

    await expect(makeClient().askJsonArray('p', 8192))
      .rejects.toThrow('8192 tokens went to reasoning');
  });

  it('throws when the answer is not an array', async () => {
    create.mockResolvedValue(reply('{"name": "Aberlour"}'));

    await expect(makeClient().askJsonArray('p', 512))
      .rejects.toThrow('LLM did not return a JSON array');
  });

  it('propagates a transport failure', async () => {
    create.mockRejectedValue(new Error('429 rate limited'));

    await expect(makeClient().askJsonArray('p', 512))
      .rejects.toThrow('429 rate limited');
  });
});
