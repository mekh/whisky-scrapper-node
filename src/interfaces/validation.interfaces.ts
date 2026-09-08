/**
 * Bare calendar formats {@link IsDateFormat} can validate a string against.
 * Adding a format means adding one entry to the pattern table the decorator
 * is built on and one member here — nothing else.
 */
export type DateFormat =
  | 'YYYYMMDDHHMMSS'
  | 'YYYYMMDD'
  | 'YYYY-MM-DD'
  | 'YYYY-MM';

/**
 * Shape of a free-text field validated by the `SafeText` composite.
 */
export interface SafeTextOptions {
  /**
   * Longest accepted value, in UTF-16 code units (what `String.length`
   * counts, and therefore what `@MaxLength` compares against).
   */
  max: number;

  /**
   * When true the field may be absent. Left false for a required field, the
   * same shape `IsoDate`'s own flag uses.
   */
  optional?: boolean;

  /**
   * When true a tab, a line feed and a carriage return are accepted, because
   * the field holds prose. Every other C0 control character stays rejected
   * whichever way this is set.
   */
  multiline?: boolean;

  /**
   * When true the empty string is rejected. Off by default: sending `""` is
   * how a client clears an optional text column, so a clearable field must
   * accept it.
   */
  notEmpty?: boolean;
}
