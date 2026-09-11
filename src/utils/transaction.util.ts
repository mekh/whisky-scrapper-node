import { Logger } from '@nestjs/common';
import { runOnTransactionCommit } from 'typeorm-transactional';

import { ErrorUtils } from './error.util';

/**
 * Side effects that must not run until the write they describe is durable.
 *
 * `runOnTransactionCommit` cannot be called directly for this, because it
 * throws when there is no transactional context and half of this
 * application's catalogue writers are plain autocommits —
 * `KbReconcileService` runs three of them, `StoreService.setActive` one, and
 * every standalone script its own. A caller here states "once this is
 * committed" once, and does not have to know which kind of writer it is
 * sitting in.
 */
export class TransactionUtils {
  private static readonly logger = new Logger(TransactionUtils.name);

  /**
   * Runs `callback` once the surrounding transaction commits, or straight
   * away when there is no transaction to wait for.
   *
   * Three properties are load-bearing:
   *
   * - **The immediate path is correct, not a shortcut.** Outside a
   *   transaction the write that preceded this call has already committed,
   *   so "after the commit" is "now".
   * - **The callback can never escape.** The library fires its commit hook
   *   from a `setImmediate`, that is from a bare macrotask with nothing
   *   above it to catch anything, so a callback that threw would take the
   *   process down. It is wrapped rather than trusted.
   * - **It survives the unit specs.** Several of them mock
   *   `typeorm-transactional` down to `{ Transactional }`, which leaves this
   *   import undefined; calling it then throws a `TypeError`, which lands in
   *   the same branch as a missing context and runs the callback
   *   synchronously — so a spec sees the effect without knowing any of this.
   *
   * A transaction that rolls back never fires the hook, which is the wanted
   * behaviour: nothing was written, so nothing downstream should react.
   *
   * @param callback - The side effect to run once the write is durable.
   */
  public static afterCommit(callback: () => void): void {
    const guarded = (): void => {
      try {
        callback();
      } catch (error) {
        TransactionUtils.logger.warn(
          'An after-commit hook failed: %s',
          ErrorUtils.text(error),
        );
      }
    };

    try {
      runOnTransactionCommit(guarded);
    } catch {
      guarded();
    }
  }
}
