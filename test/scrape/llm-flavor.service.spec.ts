import 'reflect-metadata';

import { LlmFlavorService } from '../../src/scrape/llm/llm-flavor.service';

import type { ScrapeConfig } from '~config';
import type { LlmClientService } from '../../src/scrape/llm/llm-client.service';
import type { LlmFlavorCandidate } from '../../src/scrape/llm/llm.interfaces';

const askJsonArray = jest.fn();

function makeService(enabled = true): LlmFlavorService {
  return new LlmFlavorService(
    { enabled, askJsonArray } as unknown as LlmClientService,
    {
      llmFlavorModel: 'vendor/flavor-model',
      llmFlavorReasoning: false,
    } as unknown as ScrapeConfig,
  );
}

function candidate(
  name: string,
  over: Partial<LlmFlavorCandidate> = {},
): LlmFlavorCandidate {
  return { name, ...over };
}

/**
 * The prompt listing of the single call made, for asserting what grounding an
 * item contributed.
 */
function sentPrompt(): string {
  const [prompt] = askJsonArray.mock.calls[0] as [string];

  return prompt;
}

describe('LlmFlavorService.classify', () => {
  beforeEach(() => {
    askJsonArray.mockReset();
  });

  it('is a no-op when the LLM endpoint is not configured', async () => {
    const items = [candidate('Laphroaig 10')];

    await makeService(false).classify(items);

    expect(askJsonArray).not.toHaveBeenCalled();
    expect(items[0].llmFlavorChecked).toBeUndefined();
  });

  it('records the allowed tags the model returned', async () => {
    askJsonArray.mockResolvedValue([{
      confidence: 'high',
      flavor_tags: ['Peated', 'maritime', 'smoky'],
    }]);

    const items = [candidate('Laphroaig 10')];

    await makeService().classify(items);

    expect(items[0].llmFlavorConfidence).toBe('high');
    expect(items[0].llmFlavorTags).toEqual(['maritime', 'peated', 'smoky']);
    expect(items[0].llmFlavorChecked).toBe(true);
  });

  it('drops tags outside the closed vocabulary', async () => {
    askJsonArray.mockResolvedValue([{
      confidence: 'low',
      flavor_tags: ['sherry', 'butterscotch', 'торф', 'a long sentence'],
    }]);

    const items = [candidate('Some Obscure Bottling')];

    await makeService().classify(items);

    expect(items[0].llmFlavorTags).toEqual(['sherry']);
  });

  it('forces an empty result when the model answers unknown', async () => {
    askJsonArray.mockResolvedValue([{
      confidence: 'unknown',
      flavor_tags: ['peated', 'smoky'],
    }]);

    const items = [candidate('Private Cask No. 4471')];

    await makeService().classify(items);

    expect(items[0].llmFlavorConfidence).toBe('unknown');
    expect(items[0].llmFlavorTags).toEqual([]);
    expect(items[0].llmFlavorChecked).toBe(true);
  });

  it('treats an unrecognized confidence value as unknown', async () => {
    askJsonArray.mockResolvedValue([{
      confidence: 'very sure',
      flavor_tags: ['peated'],
    }]);

    const items = [candidate('Laphroaig 10')];

    await makeService().classify(items);

    expect(items[0].llmFlavorConfidence).toBe('unknown');
    expect(items[0].llmFlavorTags).toEqual([]);
  });

  it('leaves an item unchecked when its batch fails', async () => {
    askJsonArray.mockRejectedValue(new Error('429'));

    const items = [candidate('Laphroaig 10')];

    await expect(makeService().classify(items)).resolves.toBeUndefined();
    expect(items[0].llmFlavorChecked).toBeUndefined();
    expect(items[0].llmFlavorTags).toBeUndefined();
  });

  it('leaves an item unchecked when the answer omits it', async () => {
    askJsonArray.mockResolvedValue([{ confidence: 'high', flavor_tags: [] }]);

    const items = [candidate('Laphroaig 10'), candidate('Ardbeg 10')];

    await makeService().classify(items);

    expect(items[0].llmFlavorChecked).toBe(true);
    expect(items[1].llmFlavorChecked).toBeUndefined();
  });

  it(
    'calls the client with the flavor-specific model and reasoning',
    async () => {
      askJsonArray.mockResolvedValue([{ confidence: 'unknown' }]);

      await makeService().classify([candidate('Laphroaig 10')]);

      expect(askJsonArray).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        { model: 'vendor/flavor-model', reasoning: false },
      );
    },
  );

  it('grounds the prompt with the type and country when known', async () => {
    askJsonArray.mockResolvedValue([{ confidence: 'unknown' }]);

    await makeService().classify([
      candidate('Laphroaig 10', {
        whiskyType: 'single malt',
        country: 'Шотландія',
      }),
    ]);

    expect(sentPrompt()).toContain(
      'Laphroaig 10 | type: single malt | country: Шотландія',
    );
  });

  it('reads the description out of rawAttrs and truncates it', async () => {
    askJsonArray.mockResolvedValue([{ confidence: 'unknown' }]);

    const description = 'т'.repeat(400);

    await makeService().classify([
      candidate('Laphroaig 10', { rawAttrs: { description } }),
    ]);

    const prompt = sentPrompt();

    expect(prompt).toContain(`description: ${'т'.repeat(300)}`);
    expect(prompt).not.toContain('т'.repeat(301));
  });

  it('omits the description when the item carries none', async () => {
    askJsonArray.mockResolvedValue([{ confidence: 'unknown' }]);

    await makeService().classify([
      candidate('Laphroaig 10', { rawAttrs: { category: 'viski' } }),
    ]);

    expect(sentPrompt()).not.toContain('description:');
  });
});
