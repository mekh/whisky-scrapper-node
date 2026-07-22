export enum ReportKind {
  BEST = 'best',
  CATALOG = 'catalog',
  DROPS = 'drops',
  LOW = 'low',
  NEW = 'new',
}

export enum ReportWindow {
  TODAY = 'today',
  YESTERDAY = 'yesterday',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export enum ReportSortField {
  ABV = 'abv',
  AGE = 'age',
  COUNTRY_NAME = 'countryName',
  DISCOUNT_PCT = 'discountPct',
  NAME = 'name',
  PREVIOUS_PRICE = 'previousPrice',
  PRICE = 'price',
  STORE_NAME = 'storeName',
  TYPE = 'type',
  VOLUME_ML = 'volumeMl',
}
