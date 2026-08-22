export interface NameAgeSearch {
  /**
   * The name part of the term: everything before the trailing number, with
   * the separating whitespace dropped (`Glenfiddich 12` -> `Glenfiddich`).
   * Never empty — a term that is only a number is not split.
   */
  name: string;

  /**
   * The age the trailing number states, in years.
   */
  age: number;
}
