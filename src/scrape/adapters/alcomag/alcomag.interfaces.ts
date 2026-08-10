/**
 * The snapshot field an Alcomag specification label fills.
 */
export enum AlcomagSpecField {
  /**
   * Country of origin (`Країна`).
   */
  COUNTRY = 'country',
  /**
   * Bottle volume (`` Об`єм ``).
   */
  VOLUME = 'volume',
  /**
   * Alcohol by volume (`Міцність`).
   */
  ABV = 'abv',
  /**
   * Whisky type (`Тип`).
   */
  WHISKY_TYPE = 'whiskyType',
  /**
   * Age statement (`Витримка`) — a spec field, not the marketing prose, so it
   * is a legitimate age source (the same rule the okwine adapter follows).
   */
  AGE = 'age',
}
