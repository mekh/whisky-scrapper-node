import 'reflect-metadata';

import { KbKeyUtils } from '~utils';

describe('KbKeyUtils.key', () => {
  it('lower-cases and collapses punctuation to single spaces', () => {
    expect(KbKeyUtils.key('Gordon & MacPhail')).toBe('gordon macphail');
    expect(KbKeyUtils.key('Roe + Co')).toBe('roe co');
    expect(KbKeyUtils.key('  Glen   Scotia  ')).toBe('glen scotia');
  });

  it('drops apostrophes in every shape the sources use', () => {
    expect(KbKeyUtils.key("Jack Daniel's")).toBe('jack daniels');
    expect(KbKeyUtils.key('Jack Daniel’s')).toBe('jack daniels');
    expect(KbKeyUtils.key('Jack Daniel`s')).toBe('jack daniels');
    expect(KbKeyUtils.key('Jack Daniel´s')).toBe('jack daniels');
  });

  /**
   * The one behavioural difference from `NormalizeService.brandHaystack`, and
   * the reason this utility exists separately: one store's name cleaner
   * already emits `Bunnahabhain Moine` while another spells it `Mòine`, and a
   * peat rule that silently fails to match is exactly the failure being
   * removed.
   */
  it('folds diacritics so accented and plain spellings agree', () => {
    expect(KbKeyUtils.key('Mòine')).toBe('moine');
    expect(KbKeyUtils.key('Moine')).toBe('moine');
    expect(KbKeyUtils.key('Toiteach a Dhà')).toBe('toiteach a dha');
    expect(KbKeyUtils.key('Stiùireadair')).toBe('stiuireadair');
    expect(KbKeyUtils.key('Cù Bòcan')).toBe('cu bocan');
  });

  it('keeps Cyrillic letters, which brand aliases still need', () => {
    expect(KbKeyUtils.key('Хайленд Парк')).toBe('хайленд парк');
    expect(KbKeyUtils.key("Торф'яний")).toBe('торфяний');
  });

  it('keeps digits, which are part of several real names', () => {
    expect(KbKeyUtils.key('Octomore 13.3')).toBe('octomore 13 3');
    expect(KbKeyUtils.key('Chapter 7')).toBe('chapter 7');
  });

  it('yields an empty key for text with nothing matchable', () => {
    expect(KbKeyUtils.key('')).toBe('');
    expect(KbKeyUtils.key('--- ///')).toBe('');
  });
});

describe('KbKeyUtils.normalize', () => {
  it('wraps the key in spaces so callers get whole-word tests free', () => {
    expect(KbKeyUtils.normalize('Ledaig')).toBe(' ledaig ');
  });
});

describe('KbKeyUtils.matchesWord', () => {
  const haystack = KbKeyUtils.normalize('Bruichladdich Port Charlotte 10');

  it('matches a multi-word pattern', () => {
    expect(KbKeyUtils.matchesWord(haystack, 'port charlotte')).toBe(true);
  });

  it('matches at the start and at the end of the name', () => {
    expect(KbKeyUtils.matchesWord(haystack, 'bruichladdich')).toBe(true);
    expect(KbKeyUtils.matchesWord(haystack, '10')).toBe(true);
  });

  /**
   * The guard that keeps the catalogue's `Johnny Smoking Gun` from reading as
   * peated and `Arran` from matching inside `arrangement`.
   */
  it('never matches inside a longer word', () => {
    const smoking = KbKeyUtils.normalize('Johnny Smoking Gun');

    expect(KbKeyUtils.matchesWord(smoking, 'smok')).toBe(false);
    expect(KbKeyUtils.matchesWord(KbKeyUtils.normalize('repeat'), 'peat'))
      .toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(KbKeyUtils.matchesWord(haystack, '')).toBe(false);
  });
});

describe('KbKeyUtils.matchesPrefix', () => {
  it('matches a word-initial prefix, for Ukrainian inflection', () => {
    const forms = ["Торф'яний", 'Торфяний', 'Торфяністю'];

    forms.forEach((form) => {
      expect(KbKeyUtils.matchesPrefix(KbKeyUtils.normalize(form), 'торф'))
        .toBe(true);
    });
  });

  it('still anchors at a word boundary', () => {
    expect(
      KbKeyUtils.matchesPrefix(KbKeyUtils.normalize('repeat'), 'peat'),
    ).toBe(false);
  });

  it('never matches an empty pattern', () => {
    expect(KbKeyUtils.matchesPrefix(KbKeyUtils.normalize('anything'), ''))
      .toBe(false);
  });
});
