import type { FactSource } from '~enums';
import type { ID } from '~types';

/**
 * One bottling as the re-derivation reads it: the raw name to classify and the
 * stored facts to compare against.
 */
export interface RederiveRow {
  /**
   * Canonical product id.
   */
  id: ID;

  /**
   * The longest raw listing name any store carries for this bottling — the one
   * holding the most descriptors, and so the best keyword input.
   */
  nameOrig: string;

  /**
   * The stored whisky type, so an unchanged value is not rewritten.
   */
  typeId: ID | null;

  /**
   * Where the stored type came from.
   */
  typeSource: FactSource | null;

  /**
   * The stored country.
   */
  countryId: ID | null;

  /**
   * Where the stored country came from.
   */
  countrySource: FactSource | null;
}
