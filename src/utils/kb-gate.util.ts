import { KbStatus, PeatProfile, ProducerKind, ScotlandRegion } from '~enums';
import type { KbGateInput } from '~types';

/**
 * Words in a producer's own name that corroborate a positive peat claim.
 */
const PEAT_WORDS = ['peat', 'peated', 'peaty', 'smoke', 'smoky', 'moine'];

/**
 * Decides whether a researched producer may go live without a person reading
 * it.
 *
 * It lives here rather than inside the merge script because two callers need
 * it and they must not drift: `pnpm kb-merge`, which gates the one-off seed,
 * and `pnpm research-brands`, which gates every brand discovered afterwards. A
 * second copy would be a second policy, and this policy is the only thing
 * standing between a model's recollection and a filter the owner trusts.
 */
export class KbGateUtils {
  /**
   * Grades one producer.
   *
   * The gate is **asymmetric**, and that asymmetry is the whole safety
   * argument. A wrong `none` can only ever remove peat tags from a whisky —
   * the user sees one extra bottle in a filtered list and notices. A wrong
   * positive removes a whisky from his results entirely and leaves no trace;
   * that is exactly how `Tobermory 12` disappeared. So `none` auto-applies on
   * ordinary evidence, while a positive claim also needs something independent
   * pointing the same way: an Islay address, a peat word in the producer's own
   * name, or a citation from the producer's own domain.
   *
   * A bottler passes unconditionally. It carries no peat claim by
   * construction, and the resolver refuses to put a bottler in the producer
   * slot at all, so its country and type are never read either — withholding
   * one buys no safety and costs the whole independent-bottling path.
   *
   * Everything that fails is still stored, as `unverified`, which the resolver
   * ignores. The research is never lost, only withheld.
   *
   * @param row - The producer to grade.
   * @returns `auto` when it may go live, `unverified` otherwise.
   */
  public static status(row: KbGateInput): KbStatus {
    const cited = (row.sourceUrls ?? '').split(' ').filter(Boolean);

    const credible = row.confidence === 'high' && cited.length > 0
      && Boolean(row.countryCode);

    if (
      row.kind === ProducerKind.BOTTLER
      && row.peatProfile === PeatProfile.UNKNOWN
    ) {
      return KbStatus.AUTO;
    }

    if (!credible) {
      return KbStatus.UNVERIFIED;
    }

    if (
      row.peatProfile === PeatProfile.UNKNOWN
      || row.peatProfile === PeatProfile.NONE
    ) {
      return KbStatus.AUTO;
    }

    return KbGateUtils.corroborated(row, cited)
      ? KbStatus.AUTO
      : KbStatus.UNVERIFIED;
  }

  /**
   * Whether a positive peat claim has independent support.
   *
   * @param row - The producer.
   * @param cited - Its citations, already split.
   * @returns True when something other than the claim itself agrees with it.
   */
  private static corroborated(row: KbGateInput, cited: string[]): boolean {
    const slugWords = row.slug.split('-');
    const named = PEAT_WORDS.some((word) => slugWords.includes(word));
    const islay = row.region === ScotlandRegion.ISLAY;

    const official = cited.some((url) =>
      slugWords.some((word) => word.length > 4 && url.includes(word))
    );

    return named || islay || official;
  }
}
