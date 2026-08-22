export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

export const PUSH_KEY_MAX_LENGTH = 256;

export const PUSH_USER_AGENT_MAX_LENGTH = 512;

/**
 * How many bottlings a digest body names; anything beyond becomes the
 * "and N more" tail.
 */
export const PUSH_DIGEST_MAX_ITEMS = 5;

/**
 * Byte budget for the JSON payload of one push message. Push services cap the
 * encrypted message at 4096 bytes and encryption adds overhead, so the
 * plaintext stays well under.
 */
export const PUSH_PAYLOAD_MAX_BYTES = 3500;

/**
 * A drop is only announced when the previous snapshot is at most this many
 * days old. An offer returning after a longer gap has a new price, not a
 * discount.
 */
export const PUSH_MAX_PREVIOUS_GAP_DAYS = 30;

/**
 * User-facing notification copy, Ukrainian like the whole UI. It lives here,
 * on the server, because the service worker that renders a push has no API
 * access and no i18n layer — the payload must arrive fully rendered. This
 * file is the single place backend user-facing strings exist; `%d` is
 * replaced by `PushDigestUtils`.
 */
export const PUSH_TITLE_ONE = 'Знижка на віскі з обраного';

export const PUSH_TITLE_MANY = 'Знижки на %d віскі з обраного';

export const PUSH_MORE_TAIL = 'та ще %d';

export const PUSH_TEST_TITLE = 'Тестове повідомлення';

export const PUSH_TEST_BODY = 'Сповіщення про знижки працюють.';

/**
 * Where a notification click lands: the single dropped bottling, or the
 * favorites-only drops report when the digest covers several.
 */
export const PUSH_PRODUCT_URL = '/product/%s';

export const PUSH_DROPS_URL = '/drops?favoritesOnly=true';

export const PUSH_TEST_URL = '/settings/notifications';
