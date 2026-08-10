import 'reflect-metadata';

import { LlmNameExtractionService } from '../../src/scrape/llm/llm-name-extraction.service';

import type { ScrapeConfig } from '~config';
import type { LlmClientService } from '../../src/scrape/llm/llm-client.service';
import type { LlmNameCandidate } from '../../src/scrape/llm/llm.interfaces';

const askJsonArray = jest.fn();

function makeService(enabled = true): LlmNameExtractionService {
  return new LlmNameExtractionService(
    { enabled, askJsonArray } as unknown as LlmClientService,
    { llmConcurrency: 1 } as unknown as ScrapeConfig,
  );
}

function candidates(...names: string[]): LlmNameCandidate[] {
  return names.map((name) => ({ name }));
}

describe('LlmNameExtractionService.extractNames', () => {
  beforeEach(() => {
    askJsonArray.mockReset();
  });

  it('is a no-op when the LLM endpoint is not configured', async () => {
    const items = candidates('Віскі Aberlour 12 років');

    await makeService(false).extractNames(items);

    expect(askJsonArray).not.toHaveBeenCalled();
    expect(items[0].cleanName).toBeUndefined();
  });

  it('fills the extracted name', async () => {
    askJsonArray.mockResolvedValue(['Aberlour']);

    const items = candidates('Віскі Aberlour 12 років 40% 0,7л');

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Aberlour');
  });

  it('splits the batch into chunks of 40', async () => {
    askJsonArray.mockImplementation((prompt: string) => {
      const lines = prompt
        .split('Product names:\n')[1]
        .trim()
        .split('\n');

      return Promise.resolve(lines.map(() => 'Aberlour'));
    });

    const items = candidates(
      ...Array.from({ length: 85 }, () => 'Віскі Aberlour 12 років'),
    );

    await makeService().extractNames(items);

    expect(askJsonArray).toHaveBeenCalledTimes(3);
    expect(items.every((item) => item.cleanName === 'Aberlour')).toBe(true);
  });

  it('rejects a name carrying words absent from the raw one', async () => {
    askJsonArray.mockResolvedValue(['Glenfiddich Reserve']);

    const items = candidates('Віскі Aberlour 12 років 40% 0,7л');

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBeUndefined();
  });

  it('accepts an apostrophe variant of the raw spelling', async () => {
    askJsonArray.mockResolvedValue(['Jeffersons Bourbon']);

    const items = candidates("Віскі Jefferson's Bourbon 41,15% 0,7л");

    await makeService().extractNames(items);

    // `Bourbon` is then dropped as a category word by the deterministic pass.
    expect(items[0].cleanName).toBe('Jeffersons');
  });

  it('keeps an all-Cyrillic brand the prefix rule would wipe out', async () => {
    askJsonArray.mockResolvedValue(['Глен Тернер']);

    const items = candidates('Віскі Глен Тернер 12 років 0,7 л 40%');

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Глен Тернер');
  });

  it('strips residue the model left in an otherwise valid name', async () => {
    askJsonArray.mockResolvedValue(['Aberlour 12yo']);

    const items = candidates('Віскі Aberlour 12yo 40% 0,7л');

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Aberlour');
  });

  it('leaves candidates untouched when the call throws', async () => {
    askJsonArray.mockRejectedValue(new Error('429'));

    const items = candidates('Віскі Aberlour 12 років');

    await expect(makeService().extractNames(items)).resolves.toBeUndefined();
    expect(items[0].cleanName).toBeUndefined();
  });

  it('ignores a short array, leaving the other candidates alone', async () => {
    askJsonArray.mockResolvedValue(['Aberlour']);

    const items = candidates(
      'Віскі Aberlour 12 років',
      'Віскі Speyburn 10 років',
    );

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Aberlour');
    expect(items[1].cleanName).toBeUndefined();
  });

  it("rejects an answer that drops a gift set's other bottles", async () => {
    askJsonArray.mockResolvedValue(['Jura Journey']);

    const items = candidates(
      'Віскі Jura Journey 0.7 л 40% + Jura 12yo 0.7 л 40% '
        + '+ Jura Rum Cask Finish 0.7 л 40%',
    );

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBeUndefined();
  });

  it('accepts an answer that keeps the set', async () => {
    askJsonArray.mockResolvedValue(['Jura Journey + Jura + Jura Rum Cask']);

    const items = candidates(
      'Віскі Jura Journey 0.7 л 40% + Jura 12yo 0.7 л 40% '
        + '+ Jura Rum Cask Finish 0.7 л 40%',
    );

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Jura Journey + Jura + Jura Rum Cask');
  });

  it('drops a bare age number the raw name states as the age', async () => {
    askJsonArray.mockResolvedValue(['Balblair 21']);

    const items = candidates('Віскі Balblair 21 рік 46% 0,7л');

    await makeService().extractNames(items);

    expect(items[0].cleanName).toBe('Balblair');
  });
});
