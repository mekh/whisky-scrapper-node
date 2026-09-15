/**
 * The snapshot field a Best Wine product-page attribute fills. The attribute
 * set varies between products, so the page is read as a label-to-value
 * dictionary rather than by position.
 */
export enum VinaMiraAttribute {
  /**
   * Country of origin (`Країна`).
   */
  COUNTRY = 'country',
  /**
   * Bottle volume (`Обсяг`), stated as a bare litre number (`0,5`).
   */
  VOLUME = 'volume',
  /**
   * Alcohol by volume (`Міцність`), where the product states one.
   */
  ABV = 'abv',
  /**
   * Whisky type (`Тип віскі`), the Ukrainian spelling (`Односолодовий`).
   */
  WHISKY_TYPE = 'whiskyType',
}
