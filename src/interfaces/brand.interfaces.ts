/**
 * One brand as the brand autocomplete offers it. An object rather than a bare
 * string so the response can gain a hint (product count, stock) without a
 * breaking change.
 */
export interface TypeBrand {
  /**
   * Canonical name as `producer.name` holds it — the exact form the blacklist
   * API accepts, and the same string `/report` prints as a row's `brand`.
   */
  name: string;
}
