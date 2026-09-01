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

  /**
   * A store's category label in the brand field must never become a `brand`
   * row. `& Whisky` is how it went wrong: goodwine's own department name
   * (`&wine` / `&whisky` / `&food`) reached the table through a legacy
   * import, every matcher folded it to the bare word `whisky`, and the
   * brand-from-name pass then handed it to every listing whose name ends in
   * that word. The live re-mint path is bayadera's category-prefix strip,
   * which turns `Віскі & whisky` into `& whisky` before it gets here.
   */
  it('drops a value that names the category rather than the brand', () => {
    expect(cb('& whisky')).toBeNull();
    expect(cb('& Whisky')).toBeNull();
    expect(cb('Whisky')).toBeNull();
    expect(cb('Single Malt')).toBeNull();
    expect(cb('Blended Whiskey')).toBeNull();
    expect(cb('Віскі & whisky')).toBeNull();
  });

  /**
   * The guard above must cost nothing real. Each of these carries a category
   * word or an ampersand and is still a brand, and `grain` is deliberately
   * absent from the stop vocabulary precisely so `Malt & Grain` survives.
   */
  it('keeps a real brand that merely contains a category word', () => {
    expect(cb('Malt & Grain')).toBe('Malt & Grain');
    expect(cb('Gordon & MacPhail')).toBe('Gordon & MacPhail');
    expect(cb('Nikka Whisky')).toBe('Nikka Whisky');
    expect(cb('The Whisky Baron')).toBe('The Whisky Baron');
  });
});
