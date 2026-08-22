import { ID } from './entity.interfaces';

/**
 * Request shape for registering (or refreshing) a browser's push
 * subscription. The three fields are the flattened form of the browser's
 * `PushSubscription.toJSON()` — flat on purpose, so the DTO needs no nested
 * validation.
 */
export interface PushSubscribeInput {
  /**
   * The push service URL. The unique identity of the subscription.
   */
  endpoint: string;

  /**
   * Client public key, base64url.
   */
  p256dh: string;

  /**
   * Client auth secret, base64url.
   */
  auth: string;
}

/**
 * Request shape for dropping one browser's subscription.
 */
export interface PushUnsubscribeInput {
  /**
   * The push service URL of the subscription to drop.
   */
  endpoint: string;
}

/**
 * Request shape for a manually triggered digest dispatch.
 */
export interface PushDispatchInput {
  /**
   * Capture day (`YYYY-MM-DD`) to dispatch drops for. Defaults to the latest
   * day present in `price_snapshot`.
   */
  capturedOn?: string;
}

/**
 * What the client needs to offer the push opt-in: whether the server can send
 * at all, and the VAPID public key to subscribe with.
 */
export interface PushClientConfig {
  /**
   * True when the server holds usable VAPID keys and the feature is on.
   */
  enabled: boolean;

  /**
   * VAPID public key (base64url) for `pushManager.subscribe`, or null while
   * the feature is off.
   */
  publicKey: string | null;
}

/**
 * One subscribed browser, as the settings screen lists it. The key material
 * never leaves the server.
 */
export interface PushDevice {
  /**
   * Subscription row id.
   */
  id: ID;

  /**
   * The subscribing browser's User-Agent, or null when it was not captured.
   */
  userAgent: string | null;

  /**
   * When the device subscribed.
   */
  createdAt: Date;

  /**
   * When a push was last accepted by the push service for this device, or
   * null before the first send.
   */
  lastSuccessAt: Date | null;
}

/**
 * A user's subscribed devices.
 */
export interface PushDevices {
  /**
   * The devices, newest first.
   */
  devices: PushDevice[];

  /**
   * Convenience count of `devices`.
   */
  total: number;
}

/**
 * One claimed price drop on one store's offer of a favorited bottling — a row
 * of `PushRepository.claimDrops`. Several rows may share a `productId` when
 * more than one store dropped the price the same day.
 */
export interface PushDropRow {
  /**
   * The user to notify.
   */
  userId: ID;

  /**
   * The favorited bottling.
   */
  productId: ID;

  /**
   * The store offer the drop was observed on.
   */
  storeProductId: ID;

  /**
   * Canonical product name (brand + expression, age stripped), or null when
   * the bottling has none yet.
   */
  name: string | null;

  /**
   * The offer's raw scraped name — the fallback when `name` is null. It still
   * carries the age inline, which is why the age is appended only to `name`.
   */
  nameOrig: string;

  /**
   * Age statement in years, or null for NAS bottlings.
   */
  age: number | null;

  /**
   * Name of the store whose offer dropped.
   */
  storeName: string;

  /**
   * The new, dropped price.
   */
  price: number;

  /**
   * The previous recorded price the drop is measured against.
   */
  previousPrice: number;

  /**
   * ISO currency code of both prices.
   */
  currency: string;

  /**
   * Whole-percent discount of `price` against `previousPrice`.
   */
  discountPct: number;
}

/**
 * One digest line: a bottling reduced to its best drop across the claimed
 * offers.
 */
export interface PushDigestItem {
  /**
   * The favorited bottling.
   */
  productId: ID;

  /**
   * Display name, age appended when the bottling has one.
   */
  name: string;

  /**
   * The largest whole-percent discount among the bottling's claimed offers.
   */
  discountPct: number;

  /**
   * How many distinct stores dropped the price.
   */
  storeCount: number;
}

/**
 * The JSON document sent as the push message payload. The service worker
 * renders it verbatim — it has no API access, so everything it shows must
 * arrive here.
 */
export interface PushDigestPayload {
  /**
   * Notification title.
   */
  title: string;

  /**
   * Notification body — the digest lines joined into one string.
   */
  body: string;

  /**
   * Same-origin path the notification click opens.
   */
  url: string;

  /**
   * How many bottlings the digest covers, including ones trimmed from `body`.
   */
  count: number;
}

/**
 * What one dispatch pass did, for the log line and the manual endpoint's
 * response.
 */
export interface PushDispatchReport {
  /**
   * The capture day the pass dispatched drops for.
   */
  capturedOn: string;

  /**
   * How many users had at least one newly claimed drop.
   */
  users: number;

  /**
   * How many offer drops were claimed in this pass.
   */
  items: number;

  /**
   * How many push messages were accepted by push services.
   */
  sent: number;

  /**
   * How many subscriptions came back dead (404/410) and were deleted.
   */
  gone: number;

  /**
   * How many sends failed for any other reason.
   */
  failed: number;
}

/**
 * What `WebPushService.send` needs to address one subscription.
 */
export interface WebPushTarget {
  /**
   * The push service URL.
   */
  endpoint: string;

  /**
   * Client public key, base64url.
   */
  p256dh: string;

  /**
   * Client auth secret, base64url.
   */
  auth: string;
}

/**
 * What one broadcast over a set of subscriptions did — the send-side subset
 * of {@link PushDispatchReport}.
 */
export interface PushDeliveryStats {
  /**
   * How many push messages were accepted by push services.
   */
  sent: number;

  /**
   * How many subscriptions came back dead (404/410) and were deleted.
   */
  gone: number;

  /**
   * How many sends failed for any other reason.
   */
  failed: number;
}

/**
 * One subscription target still carrying its owner — what the dispatch pass
 * reads for a batch of users in one round trip.
 */
export interface PushUserTarget extends WebPushTarget {
  /**
   * The user the subscription belongs to.
   */
  userId: ID;
}

/**
 * Outcome of one push send, with the `web-push` library's error taxonomy
 * reduced to what callers act on: `gone` deletes the subscription, everything
 * else is only counted.
 */
export type WebPushOutcome =
  | 'sent'
  | 'gone'
  | 'too-large'
  | 'throttled'
  | 'failed';
