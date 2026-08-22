/**
 * One brand as the brand autocomplete offers it. An object rather than a bare
 * string so the response can gain a hint (product count, stock) without a
 * breaking change.
 */
export interface TypeBrand {
  /**
   * Canonical brand name as `brand.name` holds it — the exact form the
   * blacklist API accepts.
   */
  name: string;
}
