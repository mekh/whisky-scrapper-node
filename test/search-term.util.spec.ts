import { SearchTermUtils } from '~utils';

describe('SearchTermUtils.splitAge', () => {
  it('splits a trailing age off the name part', () => {
    expect(SearchTermUtils.splitAge('Glenfiddich 12')).toEqual({
      name: 'Glenfiddich',
      age: 12,
    });
    expect(SearchTermUtils.splitAge('Highland Park 8')).toEqual({
      name: 'Highland Park',
      age: 8,
    });
  });

  it('ignores the whitespace around the term and the separator', () => {
    expect(SearchTermUtils.splitAge('  Glenfiddich    12  ')).toEqual({
      name: 'Glenfiddich',
      age: 12,
    });
  });

  it('leaves a term that does not end in a number alone', () => {
    expect(SearchTermUtils.splitAge('Glenfiddich')).toBeNull();
    expect(SearchTermUtils.splitAge('Glenfiddich 12 років')).toBeNull();
    expect(SearchTermUtils.splitAge('Glenfiddich 12yo')).toBeNull();
  });

  it('keeps a bare number a plain substring search', () => {
    expect(SearchTermUtils.splitAge('12')).toBeNull();
    expect(SearchTermUtils.splitAge(' 12 ')).toBeNull();
  });

  it('does not read a vintage or a volume as an age', () => {
    expect(SearchTermUtils.splitAge('Ardbeg 1998')).toBeNull();
    expect(SearchTermUtils.splitAge('Chivas 700')).toBeNull();
  });

  it('needs whitespace before the number', () => {
    expect(SearchTermUtils.splitAge('Ardbeg10')).toBeNull();
    expect(SearchTermUtils.splitAge('Ardbeg 0,7')).toBeNull();
  });

  it('takes only the last number of the term', () => {
    expect(SearchTermUtils.splitAge('Glenfiddich 12 15')).toEqual({
      name: 'Glenfiddich 12',
      age: 15,
    });
  });

  it('treats a blank or absent term as nothing to split', () => {
    expect(SearchTermUtils.splitAge('')).toBeNull();
    expect(SearchTermUtils.splitAge('   ')).toBeNull();
    expect(SearchTermUtils.splitAge(null)).toBeNull();
    expect(SearchTermUtils.splitAge(undefined)).toBeNull();
  });
});
