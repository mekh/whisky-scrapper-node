import 'reflect-metadata';

import { LlmEnrichmentService } from '../../src/scrape/llm/llm-enrichment.service';

import type { ProductSnapshot } from '~types';
import type { LlmClientService } from '../../src/scrape/llm/llm-client.service';

const askJsonArray = jest.fn();

function makeService(enabled = true): LlmEnrichmentService {
  return new LlmEnrichmentService(
    { enabled, askJsonArray } as unknown as LlmClientService,
  );
}

function snap(
  name: string,
  over: Partial<ProductSnapshot> = {},
): ProductSnapshot {
  return {
    storeSlug: 't',
    storeSku: '1',
    url: '',
    name,
    price: 1,
    brand: null,
    oldPrice: null,
    currency: 'UAH',
    inStock: true,
    promo: false,
    volumeMl: null,
    abv: null,
    ageYears: null,
    whiskyType: null,
    country: null,
    flavorTags: [],
    rawAttrs: {},
    ...over,
  };
}

describe('LlmEnrichmentService.enrich', () => {
  beforeEach(() => {
    askJsonArray.mockReset();
  });

  it('is a no-op when the LLM endpoint is not configured', async () => {
    const snaps = [snap('Віскі Aberlour')];

    await makeService(false).enrich(snaps);

    expect(askJsonArray).not.toHaveBeenCalled();
  });

  it('fills the fields the deterministic pass left empty', async () => {
    askJsonArray.mockResolvedValue([{
      abv: 40,
      volume_ml: 700,
      whisky_type: 'Single Malt',
      country: 'Шотландія',
      flavor_tags: ['Sherry', 'fruity'],
    }]);

    const snaps = [snap('Віскі Aberlour')];

    await makeService().enrich(snaps);

    expect(snaps[0].abv).toBe(40);
    expect(snaps[0].volumeMl).toBe(700);
    expect(snaps[0].whiskyType).toBe('single malt');
    expect(snaps[0].country).toBe('Шотландія');
    expect(snaps[0].flavorTags).toEqual(['fruity', 'sherry']);
  });

  it('fills the age when the deterministic pass found none', async () => {
    askJsonArray.mockResolvedValue([{ age_years: 12.9, abv: 40 }]);

    const snaps = [snap('Віскі Aberlour')];

    await makeService().enrich(snaps);

    expect(snaps[0].ageYears).toBe(12);
  });

  it(
    'never overwrites a value the deterministic pass already found',
    async () => {
      askJsonArray.mockResolvedValue([{ abv: 43, volume_ml: 500 }]);

      const snaps = [snap('Віскі Aberlour', { abv: 40, volumeMl: 700 })];

      await makeService().enrich(snaps);

      expect(snaps[0].abv).toBe(40);
      expect(snaps[0].volumeMl).toBe(700);
    },
  );

  it('leaves snapshots untouched when the call fails', async () => {
    askJsonArray.mockRejectedValue(new Error('429'));

    const snaps = [snap('Віскі Aberlour')];

    await expect(makeService().enrich(snaps)).resolves.toBeUndefined();
    expect(snaps[0].abv).toBeNull();
  });
});
