import { ProductDuplicateMerge1788723300000 as Merge } from '../migrations/1788723300000-product-duplicate-merge';

/**
 * The barcode pass of the duplicate merge folds two rows that share a retail
 * barcode only when their names are compatible: one's significant words are
 * all among the other's. These pin the rule on the catalogue's own cases —
 * the ones a shared barcode must fold and the ones a shop's reused barcode
 * must not.
 */
describe('ProductDuplicateMerge.tokens', () => {
  it('drops the category words and keeps the rest, folded', () => {
    expect([...Merge.tokens('Віскі The Pogues SingleMalt Irish Whiskey')])
      .toEqual(['pogues', 'singlemalt', 'irish']);
  });

  it('keeps every number whatever its length', () => {
    expect([...Merge.tokens('Hyde №3 1916')]).toEqual(['hyde', '3', '1916']);
  });

  it('deletes apostrophes and folds Latin diacritics', () => {
    expect([...Merge.tokens("Jack Daniel's Rök")]).toEqual([
      'jack',
      'daniels',
      'rok',
    ]);
  });
});

describe('ProductDuplicateMerge.compatible', () => {
  it.each([
    ['Jura', 'Isle of Jura'],
    ['Restless Pony', 'Restless Pony Original'],
    ['Tamnavulin', 'Tamnavulin Speyside Single Malt'],
    ['Johnnie Walker Gold Label Reserve', 'Johnnie Walker Gold Reserve'],
    ['Tomatin Talisman', 'Tomatin Talisman Blend'],
    ['Hyde No.11 1949 Peated', 'Hyde №11 1949 Peated'],
    ['Jack Daniels', "Jack Daniel's Tennessee Old No.7"],
  ])('folds %s with %s', (left, right) => {
    expect(Merge.compatible(left, right)).toBe(true);
    expect(Merge.compatible(right, left)).toBe(true);
  });

  it.each([
    ['Clan Denny Islay', 'Clan Denny Speyside'],
    ['Hyde №3 1916', 'Hyde №4'],
    ['Kilchoman Machir Bay', 'Kilchoman Sanaig'],
    ['Glen Turner Double Cask', 'Glen Turner Rum Cask Finish'],
    ['Islay Mist Deluxe', 'Islay Mist Original'],
  ])('keeps %s apart from %s', (left, right) => {
    expect(Merge.compatible(left, right)).toBe(false);
  });

  it('refuses a name that is nothing but category words', () => {
    expect(Merge.compatible('Whisky', 'Whisky Single Malt')).toBe(false);
  });
});
