/**
 * A batch was never sent: by the time a worker picked it up the run had already
 * stopped taking new work — either the caller's LLM budget elapsed or an
 * earlier batch failed for a reason every other batch would hit too.
 *
 * Carried as its own type so a pass's error log names the reason instead of
 * reporting a transport or parsing failure that never happened.
 */
export class LlmDeadlineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LlmDeadlineError';
  }
}
