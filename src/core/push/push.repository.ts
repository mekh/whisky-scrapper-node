import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import {
  ID,
  PushDevice,
  PushDropRow,
  PushSubscribeInput,
  PushUserTarget,
} from '~types';

import { BaseRepository } from '../_common';
import { PushSubscriptionEntity } from './push-subscription.entity';

/**
 * Registers or refreshes one browser's subscription. The conflict target is
 * the unique `endpoint`: a browser profile holds one subscription per origin,
 * so a repeat POST is a refresh, and the `userId` reassignment is deliberate —
 * the same profile signed into a second account must stop pushing to the
 * first.
 */
const UPSERT_SQL = `
  INSERT INTO push_subscription ("userId", endpoint, p256dh, auth, "userAgent")
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (endpoint) DO UPDATE SET
    "userId" = EXCLUDED."userId",
    p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    "userAgent" = EXCLUDED."userAgent",
    "updatedAt" = now()
`;

/**
 * Finds today's price drops on favorited bottlings, atomically claims them,
 * and returns only what this call claimed. One statement on purpose — the
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` claim is what partitions the
 * work between concurrent dispatches and keeps a second same-day run from
 * repeating a drop.
 *
 * Decisions that are easy to undo by accident:
 *
 * - The lateral reads the previous *existing* snapshot (any date gap), so an
 *   offer that was out of stock for a week and returned cheaper is one drop.
 *   `CROSS JOIN LATERAL` with `LIMIT 1` is an inner join, so a first-ever
 *   snapshot produces no row at all. It rides
 *   `price_snapshot_store_product_captured_uindex`.
 * - `prev."capturedOn" >= $1::date - $2::int` is the stale-gap guard: a
 *   listing returning after a month at a lower price is a new price, not a
 *   discount to announce.
 * - `cur.price > 0` guards the `1.00 грн` out-of-stock placeholder some
 *   stores use, exactly as `priceEdges` does.
 * - The store's advertised strike price (`oldPrice`) is never read — the same
 *   rule as the drops report, so a permanent marketing anchor cannot
 *   fabricate a discount here.
 * - The blacklist `NOT EXISTS` pair is copied from `findCurrentRows`,
 *   NULL-brand semantics included: a brandless bottling survives every brand
 *   rule.
 * - The `push_subscription EXISTS` keeps the claim from burning dedup rows
 *   for users no push can reach.
 * - `discountPct` is computed on `numeric` before the `float8` casts; the raw
 *   `numeric` prices are carried separately into the claim insert so no
 *   float round-trip touches what is audited.
 */
const CLAIM_DROPS_SQL = `
  WITH dropped AS (
    SELECT cur."storeProductId",
           cur.price,
           cur.currency,
           prev.price AS "previousPrice"
    FROM price_snapshot cur
    CROSS JOIN LATERAL (
      SELECT p.price, p."capturedOn"
      FROM price_snapshot p
      WHERE p."storeProductId" = cur."storeProductId"
        AND p."capturedOn" < cur."capturedOn"
      ORDER BY p."capturedOn" DESC
      LIMIT 1
    ) prev
    WHERE cur."capturedOn" = $1::date
      AND cur.price > 0
      AND prev.price > cur.price
      AND prev."capturedOn" >= $1::date - $2::int
  ),
  candidate AS (
    SELECT f."userId",
           sp."productId",
           d."storeProductId",
           p.name,
           sp."nameOrig",
           p.age,
           st.name                                        AS "storeName",
           d.price                                        AS "priceNum",
           d."previousPrice"                              AS "previousNum",
           d.price::float8                                AS price,
           d."previousPrice"::float8                      AS "previousPrice",
           d.currency,
           round((d."previousPrice" - d.price)
                 / d."previousPrice" * 100)::int          AS "discountPct"
    FROM dropped d
    JOIN store_product sp ON sp.id = d."storeProductId"
    JOIN product p        ON p.id  = sp."productId"
    JOIN store st         ON st.id = sp."storeId"
    JOIN favorite f       ON f."productId" = sp."productId"
    WHERE sp."inStock"
      AND EXISTS (
        SELECT 1 FROM push_subscription s WHERE s."userId" = f."userId")
      AND NOT EXISTS (
        SELECT 1 FROM blacklist_product bp
        WHERE bp."userId" = f."userId" AND bp."productId" = sp."productId")
      AND NOT EXISTS (
        SELECT 1 FROM blacklist_brand bb
        WHERE bb."userId" = f."userId" AND bb."brandId" = p."brandId")
  ),
  claimed AS (
    INSERT INTO push_digest_log
      ("userId", "storeProductId", "capturedOn", price, "previousPrice")
    SELECT "userId", "storeProductId", $1::date, "priceNum", "previousNum"
    FROM candidate
    ON CONFLICT ("userId", "storeProductId", "capturedOn") DO NOTHING
    RETURNING "userId", "storeProductId"
  )
  SELECT c."userId", c."productId", c."storeProductId", c.name, c."nameOrig",
         c.age, c."storeName", c.price, c."previousPrice", c.currency,
         c."discountPct"
  FROM candidate c
  JOIN claimed k
    ON k."userId" = c."userId"
   AND k."storeProductId" = c."storeProductId"
  ORDER BY c."userId", c."discountPct" DESC, c.price, c."storeProductId"
`;

/**
 * Owns both push tables. They are one feature — the claim statement above
 * writes `push_digest_log` while reading `push_subscription` — so a single
 * repository is the coherent unit, the same reason `PreferenceRepository`
 * owns all three membership tables.
 */
@TypeormRepository(PushSubscriptionEntity)
export class PushRepository extends BaseRepository<PushSubscriptionEntity> {
  /**
   * Registers or refreshes one browser's subscription for a user.
   *
   * @param userId - The subscription's (possibly new) owner.
   * @param input - The flattened browser subscription.
   * @param userAgent - The subscribing browser's User-Agent, if known.
   */
  public async upsertSubscription(
    userId: ID,
    input: PushSubscribeInput,
    userAgent: string | null,
  ): Promise<void> {
    await this.query(UPSERT_SQL, [
      userId,
      input.endpoint,
      input.p256dh,
      input.auth,
      userAgent,
    ]);
  }

  /**
   * Drops one of the user's subscriptions. Scoped to the user so nobody can
   * delete another user's device by guessing an endpoint.
   *
   * @param userId - The owning user.
   * @param endpoint - The subscription's push service URL.
   */
  public async deleteByEndpoint(userId: ID, endpoint: string): Promise<void> {
    await this.query(
      `DELETE FROM push_subscription
       WHERE "userId" = $1 AND endpoint = $2`,
      [userId, endpoint],
    );
  }

  /**
   * Drops dead subscriptions, whoever owns them — a `410 Gone` endpoint is
   * dead for everyone.
   *
   * @param endpoints - Push service URLs to drop; an empty array is a no-op.
   */
  public async deleteByEndpoints(endpoints: string[]): Promise<void> {
    if (!endpoints.length) {
      return;
    }

    await this.query(
      'DELETE FROM push_subscription WHERE endpoint = ANY($1::text[])',
      [endpoints],
    );
  }

  /**
   * Lists a user's subscribed devices, newest first, without key material.
   *
   * @param userId - Whose devices to list.
   * @returns The devices; empty when the user never subscribed.
   */
  public async findDevicesByUserId(userId: ID): Promise<PushDevice[]> {
    return await this.query(
      `SELECT id, "userAgent", "createdAt", "lastSuccessAt"
       FROM push_subscription
       WHERE "userId" = $1
       ORDER BY "createdAt" DESC, id`,
      [userId],
    ) as PushDevice[];
  }

  /**
   * Loads the send targets of a set of users in one round trip.
   *
   * @param userIds - Users to load targets for; an empty array short-circuits.
   * @returns Every subscription of every listed user.
   */
  public async findTargetsByUserIds(
    userIds: ID[],
  ): Promise<PushUserTarget[]> {
    if (!userIds.length) {
      return [];
    }

    return await this.query(
      `SELECT "userId", endpoint, p256dh, auth
       FROM push_subscription
       WHERE "userId" = ANY($1::uuid[])
       ORDER BY "userId", "createdAt", id`,
      [userIds],
    ) as PushUserTarget[];
  }

  /**
   * Whether any subscription exists at all — the early exit that keeps the
   * dispatch free on an installation nobody subscribed to.
   *
   * @returns True when at least one device is subscribed.
   */
  public async hasAnySubscription(): Promise<boolean> {
    const rows = await this.query(
      'SELECT EXISTS(SELECT 1 FROM push_subscription) AS present',
    ) as { present: boolean }[];

    return rows[0]?.present ?? false;
  }

  /**
   * Stamps the subscriptions a push service just accepted a message for.
   *
   * @param endpoints - Push service URLs to stamp; an empty array is a no-op.
   */
  public async touchSuccess(endpoints: string[]): Promise<void> {
    if (!endpoints.length) {
      return;
    }

    await this.query(
      `UPDATE push_subscription
       SET "lastSuccessAt" = now()
       WHERE endpoint = ANY($1::text[])`,
      [endpoints],
    );
  }

  /**
   * Atomically claims the not-yet-announced price drops of one capture day.
   * See {@link CLAIM_DROPS_SQL} for the full semantics.
   *
   * @param capturedOn - The capture day (`YYYY-MM-DD`) to claim drops for.
   * @param maxGapDays - Oldest allowed age, in days, of the previous snapshot
   *   a drop is measured against.
   * @returns The drops this call claimed; a repeat call returns nothing new.
   */
  public async claimDrops(
    capturedOn: string,
    maxGapDays: number,
  ): Promise<PushDropRow[]> {
    return await this.query(
      CLAIM_DROPS_SQL,
      [capturedOn, maxGapDays],
    ) as PushDropRow[];
  }

  /**
   * Deletes dedup rows older than the retention window.
   *
   * @param before - Exclusive lower bound (`YYYY-MM-DD`); rows captured
   *   before it are dropped.
   */
  public async pruneDigestLog(before: string): Promise<void> {
    await this.query(
      'DELETE FROM push_digest_log WHERE "capturedOn" < $1::date',
      [before],
    );
  }
}
