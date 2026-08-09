/**
 * The model spent its whole completion budget before emitting an answer —
 * `finish_reason: "length"` with no content. On a reasoning model the chain of
 * thought grows with the batch, so the same batch split in half often fits.
 *
 * Carried as its own type purely so the batch runner can tell this apart from
 * a transport or parsing failure, which splitting would not help.
 */
export class LlmBudgetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LlmBudgetError';
  }
}
