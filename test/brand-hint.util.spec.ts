import 'reflect-metadata';

import { BrandHintUtils } from '~utils';

/**
 * Real `vina-mira` listing names, taken from the dump of 2026-09-17. The shop
 * states the maker nowhere else, and the name cleaner strips the whole
 * parenthetical, so this is the only reader of the value.
 */
describe('BrandHintUtils.fromRawName', () => {
  it('reads the Cyrillic ТМ token', () => {
    expect(
      BrandHintUtils.fromRawName(
        'Віскі Hyde #3 Bourbon cask 0,7 л 46% (Ірландія, ТМ Hyde)',
      ),
    ).toBe('Hyde');
  });

  it('reads the Latin TM token, which is a different code point', () => {
    expect(
      BrandHintUtils.fromRawName(
        "Віскі Kinahan's The Kasc Project L 0,7л 40% (Ірландія, TM Kinahan's)",
      ),
    ).toBe("Kinahan's");
  });

  it('keeps a multi-word brand whole', () => {
    expect(
      BrandHintUtils.fromRawName(
        'Віскі Mr Peat Single Malt 0,7 л 46% кор. '
          + '(Шотландія, ТМ Fox Fitzgerald)',
      ),
    ).toBe('Fox Fitzgerald');
  });

  it('stops at the closing parenthesis, not at the end of the name', () => {
    expect(
      BrandHintUtils.fromRawName(
        'Віскі Woven Superblend 0,7 л 46% (Шотландія, ТМ Woven) у коробці',
      ),
    ).toBe('Woven');
  });

  it('reads a numeric brand', () => {
    expect(
      BrandHintUtils.fromRawName(
        'Віскі 1770 Original 0,5 л 46% (Шотландія, ТМ 1770)',
      ),
    ).toBe('1770');
  });

  it('answers null for a name that states no token', () => {
    expect(BrandHintUtils.fromRawName('Віскі Jameson 0,7л. 40%')).toBeNull();
    expect(BrandHintUtils.fromRawName(null)).toBeNull();
    expect(BrandHintUtils.fromRawName('')).toBeNull();
  });

  it('never reads TM out of the middle of a word', () => {
    expect(BrandHintUtils.fromRawName('Віскі ATM Reserve (Шотландія)'))
      .toBeNull();
  });
});
