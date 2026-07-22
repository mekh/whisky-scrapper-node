import { BrandUtils } from '~utils';

describe('BrandUtils.canonical', () => {
  const cb = (raw: string | null): string | null => BrandUtils.canonical(raw);

  it('folds case and trailing-whitespace variants onto one spelling', () => {
    expect(cb('balblair')).toBe('Balblair');
    expect(cb('Balblair ')).toBe('Balblair');
    expect(cb('BALBLAIR')).toBe('Balblair');
  });

  it('normalizes MauDau lower-case hyphenated slugs', () => {
    expect(cb('highland-park')).toBe('Highland Park');
    expect(cb('caol-ila')).toBe('Caol Ila');
  });

  it('restores a possessive left by an apostrophe slug', () => {
    expect(cb('ballantine-s')).toBe("Ballantine's");
    expect(cb('maker-s-mark')).toBe("Maker's Mark");
    expect(cb("Jack Daniel's")).toBe("Jack Daniel's");
  });

  it('applies display overrides for camelCase brands and acronyms', () => {
    expect(cb('benriach')).toBe('BenRiach');
    expect(cb('BENRIACH')).toBe('BenRiach');
    expect(cb('vat 69')).toBe('VAT 69');
  });

  it('keeps connector words lower-case when not first', () => {
    expect(cb('isle-of-skye')).toBe('Isle of Skye');
  });

  it('maps known Cyrillic trademarks to their Latin brand', () => {
    expect(cb('тормор')).toBe('Tormore');
    expect(cb('кроу роял')).toBe('Crown Royal');
    expect(cb('ірішмен')).toBe('The Irishman');
  });

  it('drops unmapped Cyrillic and junk placeholders', () => {
    expect(cb('вінтер')).toBeNull();
    expect(cb('спейсайд селекшн №5')).toBeNull();
    expect(cb('no-brand')).toBeNull();
    expect(cb(null)).toBeNull();
    expect(cb('')).toBeNull();
    expect(cb('   ')).toBeNull();
  });
});
