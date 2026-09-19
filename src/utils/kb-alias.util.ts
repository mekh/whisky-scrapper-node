import { KB_NAME_ALIAS_MIN_LENGTH, ProducerAliasScope } from '~enums';
import type { ID, KbAliasEntry } from '~types';

import { KbKeyUtils } from './kb-key.util';
import { ProductMatchUtils } from './product-match.util';

/**
 * How a spelling is matched against the knowledge base's alias index.
 *
 * Extracted so the two passes that ask the question cannot answer it
 * differently. `KbResolverService` asks it to find the producer whose facts a
 * bottling inherits; `NormalizeService` asks it to decide which brand a
 * listing states and which token that brand contributes to the frozen match
 * key. Those are different jobs reading the same table, and the codebase has
 * already paid for the alternative — the note on `KbApplyService` records that
 * two implementations of one rule is the exact shape of defect the knowledge
 * base exists to remove.
 *
 * Both matchers are linear finds over an index the repository already returns
 * longest-key-first, so the first hit is the most specific one.
 */
export class KbAliasUtils {
  /**
   * Matches a brand value against the index, as a whole string.
   *
   * Whole-string equality rather than a substring test, because a brand field
   * states the brand and nothing else. That is what lets a short alias such as
   * `jb` or `m h` resolve at all: the five-character floor below exists only
   * for the substring path, where a short key would fire inside an unrelated
   * name.
   *
   * @param brandKey - The brand normalized by `KbKeyUtils.key`, or null when
   *   the listing states no brand.
   * @param aliases - The alias index.
   * @returns The matching alias, or null when nothing matches.
   */
  public static matchByBrand(
    brandKey: string | null,
    aliases: readonly KbAliasEntry[],
  ): KbAliasEntry | null {
    if (!brandKey) {
      return null;
    }

    const hit = aliases.find((alias) =>
      alias.key === brandKey
      && alias.scope !== ProducerAliasScope.NAME
    );

    return hit ?? null;
  }

  /**
   * Finds the most specific producer named inside a product name.
   *
   * Only aliases long enough to be unambiguous as a substring are considered,
   * and a caller may exclude one producer — the resolver excludes the bottler
   * it already matched, so `Douglas Laing Big Peat` does not resolve its own
   * bottler as the distillery.
   *
   * A `lead` alias is the exception to both rules: it is tested against the
   * start of the name only and is exempt from the floor. Anchoring is what
   * makes a short key safe — shops write names brand-first, so `hyde` at
   * position 0 is the brand and `blue` at position 0 is not Johnnie Walker.
   *
   * @param nameKey - The product name normalized by `KbKeyUtils.normalize`,
   *   which leaves it space-wrapped so a key matches whole words.
   * @param aliases - The alias index, longest key first.
   * @param excludeId - A producer to skip, or null to consider every one.
   * @returns The matching alias, or null when nothing matches.
   */
  public static matchInName(
    nameKey: string,
    aliases: readonly KbAliasEntry[],
    excludeId: ID | null = null,
  ): KbAliasEntry | null {
    const hit = aliases.find((alias) =>
      alias.producer.id !== excludeId
      && KbAliasUtils.matchesScope(nameKey, alias)
    );

    return hit ?? null;
  }

  /**
   * Drops the aliases that name a category rather than a producer.
   *
   * Meant to run **once per index load**, never inside a matcher: the test
   * folds and tokenizes the key, and a linear find over a thousand aliases per
   * bottling would pay for that on every comparison.
   *
   * The case it exists for is `& Whisky`, goodwine's own department label. A
   * researcher recorded it verbatim as an alias and `KbKeyUtils.key` deleted
   * the ampersand, storing the bare noun `whisky` — six characters, so the
   * five-character floor cannot catch it, and brand scope is exempt from the
   * floor anyway. Sorted longest-key-first, it then outranked every real brand
   * no longer than the word. The `brand` table's copy of that defect is fixed
   * (`brand-whisky-artifact`) and `kb-merge` now refuses to write one, but the
   * alias table is written by `research-brands` too, so the index guards
   * itself rather than trusting every writer.
   *
   * @param aliases - The alias index as loaded.
   * @returns The aliases that carry identity of their own.
   */
  public static usable(aliases: KbAliasEntry[]): KbAliasEntry[] {
    return aliases.filter((alias) =>
      ProductMatchUtils.carriesIdentity(alias.key)
    );
  }

  /**
   * Whether the resolver may look for an alias **inside** a name at all.
   *
   * The one statement of that rule, so the matcher and the curation screen's
   * `alias-unreachable` detector cannot disagree about what a spelling can
   * reach. A `brand` alias never can; a `lead` alias always can, because
   * anchoring at position 0 is what makes a short key safe; everything else
   * needs {@link KB_NAME_ALIAS_MIN_LENGTH}.
   *
   * @param alias - The alias to test.
   * @returns True when some product name could match it.
   */
  public static reachesName(alias: KbAliasEntry): boolean {
    if (alias.scope === ProducerAliasScope.BRAND) {
      return false;
    }

    return alias.scope === ProducerAliasScope.LEAD
      || alias.key.length >= KB_NAME_ALIAS_MIN_LENGTH;
  }

  /**
   * Whether one alias matches a name in the way its own scope allows.
   *
   * @param nameKey - The space-wrapped, normalized product name.
   * @param alias - The alias to test.
   * @returns True when the alias fires on this name.
   */
  private static matchesScope(
    nameKey: string,
    alias: KbAliasEntry,
  ): boolean {
    if (!KbAliasUtils.reachesName(alias)) {
      return false;
    }

    if (alias.scope === ProducerAliasScope.LEAD) {
      return nameKey.startsWith(` ${alias.key} `);
    }

    return KbKeyUtils.matchesWord(nameKey, alias.key);
  }
}
