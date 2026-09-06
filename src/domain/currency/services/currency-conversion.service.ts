import { Injectable } from '@nestjs/common';

import {
  CURRENCY_LATEST_CACHE_TTL_MS,
  CURRENCY_RATE_CACHE_SIZE,
} from '~constants';
import { CoreCurrencyService } from '~core/currency';
import { BadRequestError } from '~errors';
import {
  CurrencyConversion,
  CurrencyConvertRequest,
  CurrencyRateProbe,
} from '~types';
import { CurrencyUtils } from '~utils';

import { CurrencyService } from './currency.service';

/**
 * One memoized probe. `expiresAt` is null for an answer that can never change.
 */
interface RateCacheEntry {
  probe: CurrencyRateProbe;

  expiresAt: number | null;
}

/**
 * Converts amounts between currencies at the official rate of a given day.
 *
 * This is the service other features inject — the personal collection above
 * all, which stores a purchase price in hryvnia and has to show it in the
 * currency the user picked, at the rate of the day the bottle was bought.
 *
 * Two things about the shape are deliberate, and both exist for that caller:
 *
 * `convertMany` resolves every distinct `(currency, day)` pair a whole list
 * mentions in one round trip. Converting a two-hundred-row collection must not
 * be two hundred queries, and a caller looping over `convert` would make it
 * exactly that.
 *
 * A missing rate returns **null** rather than throwing or guessing. A purchase
 * older than the currency itself has no official rate and never will; showing
 * the amount as unconvertible is honest, whereas substituting the nearest
 * available rate would quietly invent a number. The gap-free NBU history means
 * this only ever fires at the edges.
 */
@Injectable()
export class CurrencyConversionService {
  private readonly cache = new Map<string, RateCacheEntry>();

  public constructor(
    private readonly currencies: CoreCurrencyService,
    private readonly lookup: CurrencyService,
  ) {}

  /**
   * Converts one amount.
   *
   * @param request - The amount, the two currencies, and the day whose rate
   *   to apply (today when omitted).
   * @returns The conversion, stating the rate and the day it came from, or
   *   null when no rate is stored at or before that day.
   * @throws {BadRequestError} If a currency code is unknown or the amount is
   *   not a finite number.
   */
  public async convert(
    request: CurrencyConvertRequest,
  ): Promise<CurrencyConversion | null> {
    const [only] = await this.convertMany([request]);

    return only ?? null;
  }

  /**
   * Converts a batch of amounts, resolving each distinct `(currency, day)`
   * pair exactly once.
   *
   * @param requests - The amounts to convert; they may name different
   *   currencies and different days.
   * @returns One result per request, positionally aligned with the input, each
   *   null when its rate is missing.
   * @throws {BadRequestError} If a currency code is unknown or an amount is
   *   not a finite number.
   */
  public async convertMany(
    requests: CurrencyConvertRequest[],
  ): Promise<(CurrencyConversion | null)[]> {
    if (!requests.length) {
      return [];
    }

    const base = await this.lookup.baseCode();
    const normalized = await this.normalize(requests, base);
    const rates = await this.resolveRates(normalized, base);

    return normalized.map((request) => this.apply(request, rates, base));
  }

  /**
   * Resolves the rates a batch of requests needs, keyed `code|day`.
   *
   * The base currency is never looked up — its rate against itself is 1 by
   * definition and storing it would be a row that could go stale. A batch that
   * needs nothing new, because it is base-to-base or already cached, issues no
   * query at all.
   *
   * @param requests - Normalized requests.
   * @param base - The base currency's code.
   * @returns Every probe the batch needs.
   */
  private async resolveRates(
    requests: Required<CurrencyConvertRequest>[],
    base: string,
  ): Promise<Map<string, CurrencyRateProbe>> {
    const needed = new Map<string, { code: string; day: string }>();

    requests.forEach((request) => {
      [request.from, request.to]
        .filter((code) => code !== base)
        .forEach((code) => {
          needed.set(this.key(code, request.on), { code, day: request.on });
        });
    });

    const resolved = new Map<string, CurrencyRateProbe>();
    const missing: { code: string; day: string }[] = [];

    needed.forEach((pair, key) => {
      const cached = this.fromCache(key);

      if (cached) {
        resolved.set(key, cached);
      } else {
        missing.push(pair);
      }
    });

    if (!missing.length) {
      return resolved;
    }

    const probes = await this.currencies.probeRates(missing);

    probes.forEach((probe) => {
      const key = this.key(probe.code, probe.requestedOn);

      resolved.set(key, probe);
      this.toCache(key, probe);
    });

    return resolved;
  }

  /**
   * Applies the resolved rates to one request.
   *
   * @param request - A normalized request.
   * @param rates - The probes resolved for the batch.
   * @param base - The base currency's code.
   * @returns The conversion, or null when a needed rate is missing.
   */
  private apply(
    request: Required<CurrencyConvertRequest>,
    rates: Map<string, CurrencyRateProbe>,
    base: string,
  ): CurrencyConversion | null {
    const shared = {
      amount: request.amount,
      from: request.from,
      to: request.to,
      requestedOn: request.on,
    };

    if (request.from === request.to) {
      return {
        ...shared,
        effectiveOn: null,
        fromRate: null,
        toRate: null,
        converted: CurrencyUtils.round(request.amount),
      };
    }

    const from = this.rateOf(request.from, request.on, rates, base);
    const to = this.rateOf(request.to, request.on, rates, base);

    if (!from || !to) {
      return null;
    }

    return {
      ...shared,
      effectiveOn: this.reportedDay(from, to),
      fromRate: from.rate,
      toRate: to.rate,
      converted: CurrencyUtils.convert(request.amount, from.rate, to.rate),
    };
  }

  /**
   * The rate of one currency on one day, or null when it is missing.
   *
   * @param code - Upper-case ISO 4217 code.
   * @param day - The requested day, as `YYYY-MM-DD`.
   * @param rates - The probes resolved for the batch.
   * @param base - The base currency's code.
   * @returns The rate and the day it belongs to, or null.
   */
  private rateOf(
    code: string,
    day: string,
    rates: Map<string, CurrencyRateProbe>,
    base: string,
  ): { rate: number; effectiveOn: string } | null {
    if (code === base) {
      return { rate: 1, effectiveOn: day };
    }

    const probe = rates.get(this.key(code, day));

    if (!probe || probe.rate === null || probe.effectiveOn === null) {
      return null;
    }

    return { rate: probe.rate, effectiveOn: probe.effectiveOn };
  }

  /**
   * Which day to report when two rates were applied.
   *
   * The earlier of the two, so a cross-rate whose sides landed on different
   * days states the staler one rather than implying both were current. Inside
   * the stored history the two are always equal — the source publishes every
   * calendar day — so this only matters past the last synced day.
   *
   * @param from - The source currency's resolved rate.
   * @param to - The target currency's resolved rate.
   * @returns The day to report.
   */
  private reportedDay(
    from: { effectiveOn: string },
    to: { effectiveOn: string },
  ): string {
    return from.effectiveOn < to.effectiveOn
      ? from.effectiveOn
      : to.effectiveOn;
  }

  /**
   * Validates and fills in the defaults of every request in a batch.
   *
   * @param requests - The incoming requests.
   * @param base - The base currency's code.
   * @returns The requests with codes upper-cased and `on` defaulted to today.
   * @throws {BadRequestError} If an amount is not finite or a code is unknown.
   */
  private async normalize(
    requests: CurrencyConvertRequest[],
    base: string,
  ): Promise<Required<CurrencyConvertRequest>[]> {
    const today = CurrencyUtils.today();
    const known = await this.lookup.all();

    const normalized = requests.map((request) => ({
      amount: request.amount,
      from: request.from.trim().toUpperCase(),
      to: request.to.trim().toUpperCase(),
      on: request.on ?? today,
    }));

    const badAmount = normalized.find(
      (request) => !Number.isFinite(request.amount),
    );

    if (badAmount) {
      throw new BadRequestError(`Amount is not a number: ${badAmount.amount}`);
    }

    const unknown = normalized
      .flatMap((request) => [request.from, request.to])
      .filter((code) => code !== base && !known.has(code));

    if (unknown.length) {
      throw new BadRequestError(
        `Unknown currency code(s): ${[...new Set(unknown)].join(', ')}`,
      );
    }

    return normalized;
  }

  /**
   * Reads a probe from the cache, honoring its expiry.
   *
   * @param key - The `code|day` cache key.
   * @returns The memoized probe, or null when absent or stale.
   */
  private fromCache(key: string): CurrencyRateProbe | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);

      return null;
    }

    return entry.probe;
  }

  /**
   * Memoizes a probe, and decides whether it may be kept forever.
   *
   * Only an **exact hit on a past day** is immutable: the NBU never restates a
   * published rate, so that answer cannot change. Everything else gets a short
   * TTL — a probe for today or later can be overwritten by a same-day
   * re-sync, and one that fell back to an earlier day, or found nothing at
   * all, is a hole a backfill may still fill.
   *
   * Eviction is insertion-ordered rather than least-recently-used: the entries
   * are interchangeable in cost and the map is only a spend-avoidance measure,
   * so tracking access order would buy nothing.
   *
   * @param key - The `code|day` cache key.
   * @param probe - The probe to memoize.
   */
  private toCache(key: string, probe: CurrencyRateProbe): void {
    const immutable = probe.effectiveOn === probe.requestedOn
      && probe.requestedOn < CurrencyUtils.today();

    this.cache.set(key, {
      probe,
      expiresAt: immutable ? null : Date.now() + CURRENCY_LATEST_CACHE_TTL_MS,
    });

    if (this.cache.size > CURRENCY_RATE_CACHE_SIZE) {
      const oldest = this.cache.keys().next();

      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
  }

  /**
   * The cache and lookup key of one currency-day pair.
   *
   * @param code - Upper-case ISO 4217 code.
   * @param day - The day, as `YYYY-MM-DD`.
   * @returns The composite key.
   */
  private key(code: string, day: string): string {
    return `${code}|${day}`;
  }
}
