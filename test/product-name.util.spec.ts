import { ProductNameUtils } from '~utils';

describe('ProductNameUtils.clean', () => {
  const cn = (raw: string): string | null => ProductNameUtils.clean(raw);

  it('strips the leading category prefix and the OK Wine dual name', () => {
    expect(cn('Віскі Black Bottle')).toBe('Black Bottle');
    expect(cn('Набір: віскі Chivas')).toBe('Chivas');
    expect(cn('Віскі Крагганмор / Cragganmore')).toBe('Cragganmore');
    // `Bourbon` is a category word now, so only the brand survives.
    expect(cn('Bourbon Jim Beam')).toBe('Jim Beam');
  });

  it('strips the store product code wherever it sits', () => {
    expect(cn('Віскі Old Smuggler (458372)')).toBe('Old Smuggler');
    expect(cn('Віскі Loch Lomond (5016840050216)')).toBe('Loch Lomond');
    // Nothing but a category word: the strip is undone rather than emptying it.
    expect(cn('Whisky (5000299628034_AB)')).toBe('Whisky');
    expect(cn('Glen Turner 40% (3147697523508)')).toBe('Glen Turner');
    // Cyrillic check letter, an inner separator, and a code before the box.
    expect(cn('Віскі Bankhall 40% 0,7л (5011166068815Н)')).toBe('Bankhall');
    expect(cn('Віскі Bowmore 40% 0.7 л (5010496020821_ 5010496001295)'))
      .toBe('Bowmore');
    expect(cn('Віскі Aberlour 16 років 40% 0.7 л (695419) у тубусі'))
      .toBe('Aberlour');
  });

  it('keeps a vintage and a batch note out of the code rule', () => {
    expect(cn('Віскі Glenfarclas The Family Cask (1957) 0.7 л'))
      .toBe('Glenfarclas The Family Cask (1957)');
    expect(cn('Віскі GlenAllachie Cask Strength (Batch 10) 0.7 л'))
      .toBe('GlenAllachie Cask Strength (Batch 10)');
  });

  it('keeps parenthesised text that is not a store code', () => {
    expect(cn('Ardbeg (NAS)')).toBe('Ardbeg (NAS)');
    expect(cn('Something (0.7)')).toBe('Something (0.7)');
  });

  it('does not match an age inside a longer word', () => {
    expect(cn('12 young oak')).toBe('12 young oak');
    expect(cn('Glen 12 yearly release')).toBe('Glen 12 yearly release');
  });

  it('reduces real catalogue rows to the product itself', () => {
    expect(cn('Віскі Old Smuggler, 40%, 0,7 л (458372)')).toBe('Old Smuggler');
    expect(cn('Віскі Крагганмор / Cragganmore, 12 років, 40%, 0.7л, в коробці'))
      .toBe('Cragganmore');
    expect(cn("Віскі Jefferson's Bourbon 41,15% 0,7л"))
      .toBe("Jefferson's");
    expect(cn("Віскі Ballantine's Finest 40% 4,5л"))
      .toBe("Ballantine's Finest");
  });

  it('strips every age spelling, including the Cyrillic "уо" form', () => {
    expect(cn('Віскі Aberlour 12 років 40% 0,7л')).toBe('Aberlour');
    expect(cn('Віскі Cragganmore 12yo 0.7л')).toBe('Cragganmore');
    expect(cn('Віскі Tullamore Dew 14 Y.O. 0,7л')).toBe('Tullamore Dew');
    expect(cn('Віскі Loch Lomond Single Grain 3 уо 0.7 л 46% в тубусі'))
      .toBe('Loch Lomond');
    expect(cn('Віскі Bushmills 25 років витримки 0.7 л 46%')).toBe('Bushmills');
  });

  it('keeps vintage years, which carry no age suffix', () => {
    expect(cn('Віскі Glenglassaugh Rare Cask 47yo #2230 PX Sherry 1968, 0.7 л'))
      .toBe('Glenglassaugh Rare Cask #2230 PX Sherry 1968');
    expect(cn('Віскі Scyfion Fettercairn 2007 Prosek Cask 2007, 0.7 л'))
      .toBe('Scyfion Fettercairn 2007 Prosek Cask 2007');
  });

  it('strips two-decimal ABV but keeps a discount label', () => {
    expect(cn('Віскі Deanston 46,3% 0,7л')).toBe('Deanston');
    expect(cn('Віскі Jim Beam Red Stag 32,5% 0,7л')).toBe('Jim Beam Red Stag');
    expect(cn('Віскі Grants -25% 0,7л')).toBe('Grants -25%');
  });

  it('strips a cask-strength ABV range whole', () => {
    expect(cn('Віскі Redbreast Cask Strength 12 років 48-65% 0,7л'))
      .toBe('Redbreast Cask Strength');
    expect(cn("Віскі Aberlour A'bunadh 59,8 - 61,2 % 0,7л"))
      .toBe("Aberlour A'bunadh");
  });

  it('strips volumes in both litres and millilitres', () => {
    expect(cn('Віскі John Barr Reserve 40% 1л')).toBe('John Barr Reserve');
    expect(cn('Віскі Jeffersons Ocean 45% 0,75л')).toBe('Jeffersons Ocean');
    expect(cn('Віскі Chivas Regal 700 мл')).toBe('Chivas Regal');
    expect(cn('Віскі Chivas Regal 50ml')).toBe('Chivas Regal');
  });

  it('does not treat a word after a number as a unit', () => {
    expect(cn('Віскі Glenfiddich 15 Solera 0,7л'))
      .toBe('Glenfiddich 15 Solera');
  });

  it('strips packaging descriptors', () => {
    expect(cn('Віскі Cragganmore 0.7л, в коробці')).toBe('Cragganmore');
    expect(cn('Віскі Mars Cosmo 43% 0.7 л в подарунковій упаковці'))
      .toBe('Mars Cosmo');
    expect(cn('Віскі Bushmills 46% 0.7 л у подарунковій упаковці'))
      .toBe('Bushmills');
    expect(cn('Віскі Loch Lomond 40% 0,7л коробка')).toBe('Loch Lomond');
    expect(cn('Віскі Ardnahoe Cask Strength, gift box, 0.7 л'))
      .toBe('Ardnahoe Cask Strength');
    expect(cn('Віскі Speyburn 0,7л в тубусі')).toBe('Speyburn');
  });

  it('keeps parenthesised descriptors that are not store codes', () => {
    expect(cn('Віскі Connemara Original (Peated), 0.7 л'))
      .toBe('Connemara Original (Peated)');
  });

  it('drops a multipack count whole, brackets included', () => {
    expect(cn('Упаковка віскі Hankey Bannister 40% 8.4 л (0.7 л x 12 шт.)'))
      .toBe('Hankey Bannister');
    expect(cn('Набір: віскі Wild Turkey 40.5% 1.4 л (0.7 х 2 шт.)'))
      .toBe('Wild Turkey');
    expect(cn('Віскі Bushmills Black 40% 1.4 л (2 шт. х 0.7 л)'))
      .toBe('Bushmills Black');
    expect(cn('Віскі Highland Mist 40% 0,7л х 6 шт')).toBe('Highland Mist');
  });

  it('returns null when nothing meaningful remains', () => {
    expect(cn('Віскі')).toBeNull();
    expect(cn('Віскі 40% 0,7л')).toBeNull();
    expect(cn('')).toBeNull();
  });
});

describe('ProductNameUtils.stripSpecs', () => {
  const ss = (raw: string): string | null => ProductNameUtils.stripSpecs(raw);

  it('strips specs without applying the leading-prefix rule', () => {
    expect(ss('Aberlour 12 років 40% 0,7л')).toBe('Aberlour');
    expect(ss('Глен Тернер 12 років 40% 0,7 л')).toBe('Глен Тернер');
  });

  it('keeps an all-Cyrillic name that `clean` would wipe out', () => {
    expect(ss('Глен Тернер')).toBe('Глен Тернер');
    expect(ProductNameUtils.clean('Глен Тернер')).toBeNull();
  });
});

describe('ProductNameUtils.clean — descriptors and punctuation', () => {
  const clean = (raw: string): string | null => ProductNameUtils.clean(raw);

  it('drops whisky category words wherever they sit', () => {
    expect(clean('Віскі Agitator Single Malt 43% 0,7л')).toBe('Agitator');
    expect(clean('Віски King Robert II Blended 40% 1л')).toBe('King Robert II');
    expect(clean('Бурбон Bourbon Buffalo Trace 0,7л 40%')).toBe(
      'Buffalo Trace',
    );
    expect(clean('Бурбон Benchmark Kentucky Straight №8 4yo 40%')).toBe(
      'Benchmark №8',
    );
  });

  it('drops an origin tag only at the end of the name', () => {
    expect(clean('Віскі Aber Falls Welsh 40% 0,7л')).toBe('Aber Falls');
    expect(clean('Віскі Aber Falls Single Malt Welsh Whisky 43% 0,7л')).toBe(
      'Aber Falls',
    );
    // Mid-name it can be the expression itself.
    expect(clean('Віскі Wild Turkey American Honey 35,5% 0,7л')).toBe(
      'Wild Turkey American Honey',
    );
  });

  it('keeps a brand built from words the lists contain', () => {
    expect(clean('Віскі Highland Park 12yo 40% 0,7л')).toBe('Highland Park');
    expect(clean('Віскі Islay Mist Peated Reserve 40% 0,7л')).toBe(
      'Islay Mist Peated Reserve',
    );
    expect(clean("Віскі The Irishman Founder's Reserve 40% 0,7л")).toBe(
      "The Irishman Founder's Reserve",
    );
  });

  it('renders the comma-separated and space-separated forms alike', () => {
    // The same bottling, as OK Wine and as a supermarket list it.
    expect(clean('Віскі Аерстоун / Aerstone, Land Cask, 40%, 0.7л')).toBe(
      'Aerstone Land Cask',
    );
    expect(clean('Віскі Aerstone Land Cask 40% 0,7л')).toBe(
      'Aerstone Land Cask',
    );
  });

  it('folds the typographic apostrophe onto the ASCII one', () => {
    expect(clean('Віскі Bell’s Spiced 35% 0,7л')).toBe("Bell's Spiced");
    expect(clean("Віскі Bell's Spiced 35% 0,7л")).toBe("Bell's Spiced");
  });

  it('keeps the name when stripping would leave no word', () => {
    expect(clean('Віскі Single Malt Whisky 40% 0,7л')).toBe(
      'Single Malt Whisky',
    );
    // A bare cask reference is not a name either.
    expect(clean('Віскі Blended Malt #3 21yo, 0.5 л')).toBe('Blended Malt #3');
  });

  it('keeps a category word that qualifies a cask or a finish', () => {
    expect(clean('Віскі Bushmills Bourbon Finish 40% 0,7л')).toBe(
      'Bushmills Bourbon Finish',
    );
    expect(clean('Віскі Speyburn Bourbon Cask 40% 0,7л')).toBe(
      'Speyburn Bourbon Cask',
    );
    expect(clean('Віскі Glenfiddich Bourbon Barrel Reserve 14 років 43% 0,7л'))
      .toBe('Glenfiddich Bourbon Barrel Reserve');
    // The guard is `bourbon` only: elsewhere the word really is the category.
    expect(clean('Віскі Penelope Whiskey Barrel Strength 47,5% 0,7л')).toBe(
      'Penelope Barrel Strength',
    );
  });

  it('drops a Cyrillic type or origin word wherever it sits', () => {
    expect(clean("Ballantine's Finest віскі бленд 0.7л")).toBe(
      "Ballantine's Finest",
    );
    expect(clean('Віскі Chivas Regal шотландське LE 40% 0,7л')).toBe(
      'Chivas Regal LE',
    );
    expect(clean('Віскі Fuyu Barley однозерновий 0,7л')).toBe('Fuyu Barley');
  });

  it('keeps a region word, which is far more often the name itself', () => {
    expect(clean('Віскі Clan Denny Islay Single Malt 0.7 л 40%')).toBe(
      'Clan Denny Islay',
    );
    expect(clean('Віскі Glen Scotia Campbeltown Harbour 40% 0,7л')).toBe(
      'Glen Scotia Campbeltown Harbour',
    );
  });
});

describe('ProductNameUtils.clean — source artefacts', () => {
  const clean = (raw: string): string | null => ProductNameUtils.clean(raw);

  it('folds a stray letter borrowed from the other alphabet', () => {
    // `Вiскi` with Latin `i`: the prefix rule used to stop at the `i`.
    expect(clean("Вiскi Ballantine's Bourbon Finish 7 років 40% 0,7л")).toBe(
      "Ballantine's Bourbon Finish",
    );
    expect(clean("Віскі MaсArthur's 40% 0,5л")).toBe("MacArthur's");
    expect(clean('Віскі Glenmorangie Quinta Rubаn, 0.7 л')).toBe(
      'Glenmorangie Quinta Ruban',
    );
    // A missing space is not a typo, so it is left for the prefix rule.
    expect(clean('Бурбон ВіскіOld Virginia 6 років 40% 0,7л')).toBe(
      'Old Virginia',
    );
  });

  it('takes the Latin side of a dual name', () => {
    expect(clean('Віскі Боумор №1 / Bowmore №1, 40%, 0.7л, в коробці')).toBe(
      'Bowmore №1',
    );
    expect(clean("Віскі Dewar's White Label / Дьюарс Уайт Лейбл 0,7л 40%"))
      .toBe("Dewar's White Label");
    expect(clean("Бурбон Мейкерс Марк №46 / Maker's Mark №46, 47%, 0.7л"))
      .toBe("Maker's Mark №46");
    // A Roman numeral in the transliteration must not pass for Latin.
    expect(
      clean('Віскі Блю Лейбл Кінг Джордж V / Blue Label King George V, 0.7л'),
    ).toBe('Blue Label King George V');
  });

  it('joins the sides when the slash is not a dual name', () => {
    expect(clean('Віскі Aberlour 16 yo / Double Cask, Tube, 0.7 л')).toBe(
      'Aberlour Double Cask',
    );
  });

  it('drops a bundled accessory but keeps a bundled bottle', () => {
    expect(clean('Віскі Arran Barrel Reserve + 2 склянки 0,7л')).toBe(
      'Arran Barrel Reserve',
    );
    expect(clean('Віскі Tenjaku та 2 склянки 0,7л')).toBe('Tenjaku');
    expect(clean('Віскі Evan Williams Black з двома келихами 0,7л')).toBe(
      'Evan Williams Black',
    );
    expect(clean("Віскі Jack Daniel's Old No.7 + Coca-Cola 0,7л")).toBe(
      "Jack Daniel's Old No.7",
    );
    // A three-bottle set is its own product at its own price.
    expect(clean('Віскі Four Roses + Four Roses Small Batch 0,7л')).toBe(
      'Four Roses + Four Roses Small Batch',
    );
    // The brand really is spelled with a `+`.
    expect(clean('Віскі Roe + Co 45% 0,7л')).toBe('Roe + Co');
  });

  it('drops the aging wording the age number leaves behind', () => {
    expect(clean('Віскі J&B Rare витримка 4 роки 0.5 л 40%')).toBe('J&B Rare');
    expect(clean('Бурбон Bulleit від 6-ти до 8-ми років витримки 0.7 л 45%'))
      .toBe('Bulleit');
    expect(clean('Віскі Hart Brothers Dalmore 11 лет 0,7л')).toBe(
      'Hart Brothers Dalmore',
    );
    expect(clean('Віскі Big Moustache Rye 2.5 роки витримки 0.7 л 45%')).toBe(
      'Big Moustache Rye',
    );
    // Without `від` the leading number belongs to the name.
    expect(clean('Бурбон Wild Turkey 81 до 8 років витримки 1 л 40.5%')).toBe(
      'Wild Turkey 81',
    );
  });

  it('drops a bare age only when the Cyrillic category word follows', () => {
    expect(clean('Aberlour 12 віскі односолодовий 0.7л')).toBe('Aberlour');
    // A Latin category word does not mark the number as an age.
    expect(clean('Віскі Label 5 Bourbon Barrel Single Grain 40% 1 л')).toBe(
      'Label 5 Bourbon Barrel',
    );
    // Nor does a vintage become one.
    expect(clean('Bruichladdich Islay Barley 2012 віскі односолодовий 0.7л'))
      .toBe('Bruichladdich Islay Barley 2012');
  });
});

describe('ProductNameUtils.dropSpecNumbers', () => {
  const drop = (name: string, raw: string): string =>
    ProductNameUtils.dropSpecNumbers(name, raw);

  it('drops a number the raw name states as an age', () => {
    expect(drop('Balblair 21', 'Віскі Balblair 21 рік 46% 0,7л'))
      .toBe('Balblair');
    expect(drop('Aberlour 12', 'Віскі Aberlour 12 yo 40% 0,7л'))
      .toBe('Aberlour');
  });

  it('drops a number the raw name states as an ABV', () => {
    expect(
      drop('Penderyn Legend 41', 'Віскі Penderyn Legend 41 Welsh 41% 0.7 л'),
    ).toBe('Penderyn Legend');
  });

  it('keeps a number the raw name never states as a spec', () => {
    expect(drop("Maker's Mark 46", "Віскі Maker's Mark 46 0.7 л 47%"))
      .toBe("Maker's Mark 46");
    expect(drop('Label 5', 'Віскі Label 5 12yo, gift box, 0.7 л'))
      .toBe('Label 5');
    expect(drop('Wild Turkey 101', 'Віскі Wild Turkey 101 50.5% 0.7л'))
      .toBe('Wild Turkey 101');
  });

  it('keeps the name when every token would go', () => {
    expect(drop('12', 'Віскі 12 років 40% 0,7л')).toBe('12');
  });
});

describe('ProductNameUtils.stripSpecs — fixed point', () => {
  it('strips a token the neighbouring one was hiding', () => {
    // Two origin tags in a row: the inner one only reaches the end once the
    // outer one is gone.
    expect(
      ProductNameUtils.clean(
        'Віскі The Quiet Man Irish American Whiskey 43% 0,7л',
      ),
    ).toBe('The Quiet Man');
    // The count only reaches the end once the volume is gone.
    expect(ProductNameUtils.clean('Віскі Glenfiddich Mix Pack 3х 0.7 л'))
      .toBe('Glenfiddich Mix Pack');
  });

  it('is idempotent, since it also runs over its own output', () => {
    const raws = [
      'Віскі Balblair 21 y.o. 0.7 л 46% у коробці (5010509883313)',
      'Віскі The Quiet Man Irish American Whiskey 43% 0,7л',
      'Упаковка віскі Hankey Bannister 40% 8.4 л (0.7 л x 12 шт.)',
      'Віскі',
    ];

    raws.forEach((raw) => {
      const once = ProductNameUtils.clean(raw);

      expect(once === null ? null : ProductNameUtils.stripSpecs(once))
        .toBe(once);
    });
  });
});

describe('ProductNameUtils.clean — repeated source text', () => {
  const clean = (raw: string): string | null => ProductNameUtils.clean(raw);

  it('drops a phrase the source typed twice in a row', () => {
    expect(
      clean('Віскі Wilson & Morgan Wilson & Morgan Beathan Oloroso Finish'),
    ).toBe('Wilson & Morgan Beathan Oloroso Finish');
    expect(clean('Віскі The Kinship The Kinship Caol Ila, 0.7 л'))
      .toBe('The Kinship Caol Ila');
    expect(clean('Віскі Scyfion Aultmore 2006 2006, 0.7 л'))
      .toBe('Scyfion Aultmore 2006');
  });

  it('keeps a repeat that is the product itself', () => {
    // A single repeated word can be the expression.
    expect(clean('Віскі Jameson Triple Triple 40% 0,7л'))
      .toBe('Jameson Triple Triple');
    // A gift set is named after each of its bottles.
    expect(clean('Віскі Jura Journey + Jura + Jura 0,7л'))
      .toBe('Jura Journey + Jura + Jura');
    expect(clean("Віскі Jack Daniel's Gentleman Jack 40% 0,7л"))
      .toBe("Jack Daniel's Gentleman Jack");
  });

  it("drops a store's internal de-duplication marker", () => {
    expect(clean('Віскі Old Malt Cask_dupHzEU Auchentoshan 25yo, 0.7 л'))
      .toBe('Old Malt Cask Auchentoshan');
  });
});
