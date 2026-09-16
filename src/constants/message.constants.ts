/**
 * Longest accepted subject of an admin broadcast. A subject is a row in a
 * list, not a paragraph.
 */
export const MESSAGE_SUBJECT_MAX_LENGTH = 200;

/**
 * Longest accepted body of an admin broadcast.
 */
export const MESSAGE_BODY_MAX_LENGTH = 4000;

/**
 * Longest accepted deep link carried by a message.
 */
export const MESSAGE_URL_MAX_LENGTH = 2048;

/**
 * Default page size of the inbox list, matching what the settings screen
 * renders without scrolling on a desktop.
 */
export const MESSAGE_DEFAULT_PAGE_LIMIT = 20;

/**
 * Largest page the inbox may ask for. The inbox is a reading surface, not an
 * export.
 */
export const MESSAGE_MAX_PAGE_LIMIT = 100;

/**
 * How many recipients a broadcast may name explicitly in one request. Past
 * this the caller wants a filter, not a list.
 */
export const MESSAGE_BROADCAST_MAX_EXPLICIT_IDS = 500;

/**
 * The pub/sub channel every replica publishes inbox events on and subscribes
 * to. One channel rather than one per user: the fleet is small, and a channel
 * per open tab would mean a subscribe round trip on every connect.
 */
export const MESSAGE_EVENTS_CHANNEL = 'message:events';

/**
 * How often a parked stream writes a comment line.
 *
 * It exists to keep the proxies in front of this from seeing silence:
 * HAProxy's `timeout server` is 60s and nginx's `proxy_read_timeout` defaults
 * to the same, so 20s leaves room for one lost beat.
 */
export const MESSAGE_STREAM_HEARTBEAT_MS = 20_000;

/**
 * The route the SSE stream is served on, as the deadline middleware and the
 * metrics hook need to recognize it by path.
 */
export const MESSAGE_STREAM_PATH = 'message/stream';
