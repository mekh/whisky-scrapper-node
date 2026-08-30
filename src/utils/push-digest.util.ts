import {
  PUSH_DIGEST_MAX_ITEMS,
  PUSH_DROPS_URL,
  PUSH_MORE_TAIL,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_PRODUCT_URL,
  PUSH_TITLE_MANY,
  PUSH_TITLE_ONE,
} from '~constants';
import { ID, PushDigestItem, PushDigestPayload, PushDropRow } from '~types';

/**
 * Pure digest arithmetic for the push dispatch: groups claimed price drops,
 * reduces a bottling's offers to its best drop, and renders the notification
 * payload. Stateless on purpose — everything here is unit-testable without a
 * database or a push service.
 */
export class PushDigestUtils {
  /**
   * Groups claimed drops by the user they belong to.
   *
   * @param rows - Claimed drops, any order.
   * @returns One entry per user, rows in their incoming order.
   */
  public static byUser(rows: PushDropRow[]): Map<ID, PushDropRow[]> {
    const users = new Map<ID, PushDropRow[]>();

    rows.forEach((row) => {
      const list = users.get(row.userId) ?? [];

      list.push(row);
      users.set(row.userId, list);
    });

    return users;
  }

  /**
   * Reduces one user's claimed drops to one digest line per bottling: the
   * largest discount among its offers, plus how many distinct stores dropped.
   *
   * @param rows - One user's claimed drops.
   * @returns Digest items sorted by discount descending, then by name.
   */
  public static bestPerProduct(rows: PushDropRow[]): PushDigestItem[] {
    const products = new Map<ID, PushDropRow[]>();

    rows.forEach((row) => {
      const list = products.get(row.productId) ?? [];

      list.push(row);
      products.set(row.productId, list);
    });

    const items = [...products.values()].map((offers) => {
      const best = offers.reduce(
        (top, offer) => offer.discountPct > top.discountPct ? offer : top,
      );

      const stores = new Set(offers.map((offer) => offer.storeName));

      return {
        productId: best.productId,
        name: PushDigestUtils.displayName(best),
        discountPct: best.discountPct,
        storeCount: stores.size,
      };
    });

    return items.sort((a, b) =>
      b.discountPct - a.discountPct || a.name.localeCompare(b.name)
    );
  }

  /**
   * Renders the notification payload for one user's digest items. The body
   * names at most {@link PUSH_DIGEST_MAX_ITEMS} bottlings and folds the rest
   * into an "and N more" tail; when the JSON still exceeds the push payload
   * budget, named items are moved into the tail one by one.
   *
   * @param items - Digest items, already sorted best-first.
   * @returns The payload the service worker renders verbatim.
   */
  public static payload(items: PushDigestItem[]): PushDigestPayload {
    const url = items.length === 1 && items[0]
      ? PUSH_PRODUCT_URL.replace('%s', items[0].productId)
      : PUSH_DROPS_URL;

    let shown = Math.min(items.length, PUSH_DIGEST_MAX_ITEMS);

    let payload = PushDigestUtils.render(items, shown, url);

    while (
      shown > 1
      && Buffer.byteLength(JSON.stringify(payload)) > PUSH_PAYLOAD_MAX_BYTES
    ) {
      shown -= 1;
      payload = PushDigestUtils.render(items, shown, url);
    }

    return payload;
  }

  /**
   * Builds the display name of one drop: the canonical name with the age
   * appended (the client's `composeNameParts` convention), or the raw scraped
   * name — which carries the age inline already — when no canonical name
   * exists.
   *
   * @param row - The claimed drop.
   * @returns The name the notification shows.
   */
  private static displayName(row: PushDropRow): string {
    if (row.name === null) {
      return row.nameOrig;
    }

    return row.age === null ? row.name : `${row.name} ${row.age}yo`;
  }

  /**
   * Renders the payload with the first `shown` items named in the body.
   *
   * @param items - All digest items.
   * @param shown - How many items the body names.
   * @param url - The click-through path.
   * @returns The rendered payload.
   */
  private static render(
    items: PushDigestItem[],
    shown: number,
    url: string,
  ): PushDigestPayload {
    const title = items.length === 1
      ? PUSH_TITLE_ONE
      : PUSH_TITLE_MANY.replace('%d', String(items.length));

    const lines = items
      .slice(0, shown)
      .map((item) => `${item.name} −${item.discountPct}%`);

    const rest = items.length - shown;

    if (rest > 0) {
      lines.push(PUSH_MORE_TAIL.replace('%d', String(rest)));
    }

    return {
      title,
      body: lines.join(', '),
      url,
      count: items.length,
    };
  }
}
