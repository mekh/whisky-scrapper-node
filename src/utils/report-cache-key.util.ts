import { createHash } from 'node:crypto';

import { CACHE_HASH_LENGTH } from '~constants';
import { ReportKind } from '~enums';
import type { ReportFilter, ReportOptions } from '~types';

/**
 * The key a cached report result set is addressed by, below the generation.
 *
 * What goes in is what changes the *set of groups* the report builds, and
 * nothing else. Sorting and pagination are applied to the cached set after it
 * is read, so `sort`, `order`, `page` and `perPage` are deliberately absent —
 * that is what lets one entry serve every page of a report instead of one
 * entry per page. The caller is absent for the same reason one level up: the
 * blacklists and favorites are applied per request, so the cached set belongs
 * to nobody in particular.
 *
 * Normalization is not cosmetic. Two requests that the SQL cannot tell apart
 * must land on one key, or the cache stores the same answer several times and
 * hits none of them; and two requests the SQL *can* tell apart must never
 * collide, which is the direction that would serve wrong data. Every rule
 * below is one or the other, and each mirrors a specific line of
 * `findCurrentRows`.
 */
export class ReportCacheKeyUtils {
  /**
   * Builds the entry suffix: the report kind, its day bucket, and a hash of
   * everything that shapes the result.
   *
   * The kind and the day stay readable rather than being folded into the
   * hash, so `valkey-cli --scan` shows what is cached.
   *
   * @param kind - Which report was asked for.
   * @param filter - The caller's catalogue filter.
   * @param options - The report options; only the shaping ones are read.
   * @param day - The UTC day for the kinds that read the clock, else null.
   * @returns The key suffix.
   */
  public static suffix(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
    day: string | null,
  ): string {
    const canonical = ReportCacheKeyUtils.canonical(kind, filter, options, day);

    const hash = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex')
      .slice(0, CACHE_HASH_LENGTH);

    return `${kind}:${day ?? '-'}:${hash}`;
  }

  /**
   * The normalized description of a report request, in a fixed field order.
   *
   * Exposed so the rules can be asserted directly rather than through a hash,
   * where a wrong answer is only ever "some other hex".
   *
   * @param kind - Which report was asked for.
   * @param filter - The caller's catalogue filter.
   * @param options - The report options; only the shaping ones are read.
   * @param day - The UTC day for the kinds that read the clock, else null.
   * @returns The fields that decide the result, normalized.
   */
  public static canonical(
    kind: ReportKind,
    filter: ReportFilter,
    options: ReportOptions,
    day: string | null,
  ): Record<string, unknown> {
    /**
     * Built as an ordered list rather than an object literal because the
     * hash is taken over `JSON.stringify`, which preserves insertion order:
     * two requests must not differ merely by the order their fields were
     * written in.
     */
    const fields: [string, unknown][] = [
      ['kind', kind],
      ['day', day ?? undefined],
      ['stores', ReportCacheKeyUtils.set(filter.stores)],
      ['minPrice', filter.minPrice],
      ['maxPrice', filter.maxPrice],
      ['minVolume', filter.minVolume],
      ['maxVolume', filter.maxVolume],
      ['countries', ReportCacheKeyUtils.set(filter.countries, true)],
      ['name', filter.name],
      ['types', ReportCacheKeyUtils.set(filter.types)],
      ['flavors', ReportCacheKeyUtils.set(filter.flavors)],
      ['excludeFlavors', ReportCacheKeyUtils.set(filter.excludeFlavors)],
      ['regions', ReportCacheKeyUtils.set(filter.regions)],
      ['excludeRegions', ReportCacheKeyUtils.set(filter.excludeRegions)],
      ['verifiedFacts', filter.verifiedFacts === true ? true : undefined],
      ['window', options.window],
      ['discountWindow', options.discountWindow],
      ['minDiscount', ReportCacheKeyUtils.constraining(options.minDiscount)],
    ];

    return Object.fromEntries(
      fields.filter(([, value]) => value !== undefined),
    );
  }

  /**
   * Drops a minimum that constrains nothing.
   *
   * `applyMinDiscount` returns its rows untouched on a falsy minimum, so a
   * zero has to hash like an absent one. This is the one numeric field where
   * that is true: a zero price or volume bound is a real constraint and is
   * kept.
   *
   * @param value - The requested minimum discount.
   * @returns The value, or undefined when it constrains nothing.
   */
  private static constraining(value: number | undefined): number | undefined {
    if (value === undefined || value === 0) {
      return undefined;
    }

    return value;
  }

  /**
   * Normalizes a multi-value filter to the set the SQL actually applies.
   *
   * Every one of these reaches the query as `= ANY($n)`, which is set
   * semantics: order and repetition change nothing, so two requests that
   * differ only in those must share a key. An empty array is dropped rather
   * than kept, because the query treats it as no constraint at all
   * (`filter.x?.length ? … : null`), so it has to hash the same as an absent
   * one.
   *
   * @param values - The raw values from the request.
   * @param lower - Whether to fold case, as the country predicate does.
   * @returns The normalized values, or undefined when they constrain nothing.
   */
  private static set(
    values: string[] | undefined,
    lower = false,
  ): string[] | undefined {
    if (!values?.length) {
      return undefined;
    }

    const normalized = lower
      ? values.map((value) => value.toLowerCase())
      : values;

    return [...new Set(normalized)].sort();
  }
}
