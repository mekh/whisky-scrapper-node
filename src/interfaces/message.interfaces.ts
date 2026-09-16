import { AudienceMode, MessageKind } from '~enums';

import { PaginatedInputBase } from './crud.interfaces';
import { ID } from './entity.interfaces';

/**
 * One bottling inside a discount digest, already reduced to its best offer
 * across stores.
 */
export interface MessageDigestItem {
  /**
   * The canonical bottling, so the client can link to `/product/{id}`.
   */
  productId: ID;

  /**
   * The bottling's display name, as the catalogue holds it.
   */
  name: string;

  /**
   * How far the price fell against the previous snapshot, in percent.
   */
  discountPct: number;

  /**
   * Today's price at the store this item names.
   */
  price: number;

  /**
   * The previous existing snapshot's price, which `discountPct` is measured
   * against.
   */
  previousPrice: number;

  /**
   * ISO-4217 code both prices are stated in.
   */
  currency: string;

  /**
   * The store holding the best offer for this bottling.
   */
  storeName: string;

  /**
   * How many distinct stores dropped this bottling's price today.
   */
  storeCount: number;
}

/**
 * A message's content. Which fields are populated is decided by the message's
 * {@link MessageKind}: a digest carries `items`, an authored message carries
 * `subject` and `body`.
 *
 * It is deliberately structured rather than pre-rendered text. The push
 * payload is rendered on the server because the service worker has no API
 * access; the inbox is rendered by the SPA, which knows the reader's language.
 */
export type MessagePayload = {
  /**
   * The dropped bottlings, best offer per bottling. `discount_digest` only.
   */
  items?: MessageDigestItem[];

  /**
   * How many bottlings dropped in total, which may exceed `items.length` once
   * a display cap applies. `discount_digest` only.
   */
  total?: number;

  /**
   * The authored subject, in Ukrainian. `admin_broadcast` / `system` only.
   */
  subject?: string;

  /**
   * The authored body, in Ukrainian. `admin_broadcast` / `system` only.
   */
  body?: string;

  /**
   * The English subject, when the author supplied one.
   */
  subjectEn?: string;

  /**
   * The English body, when the author supplied one.
   */
  bodyEn?: string;

  /**
   * Where the message points, as an app-relative path.
   */
  url?: string;
};

/**
 * One message as the inbox returns it, already joined to the caller's own read
 * state.
 */
export interface Message {
  /**
   * The message's id, used to mark it read or unread.
   */
  id: ID;

  /**
   * What produced it, which decides how {@link MessagePayload} is populated.
   */
  kind: MessageKind;

  /**
   * The message's content.
   */
  payload: MessagePayload;

  /**
   * When the caller read it, or null while it is unread.
   */
  readAt: Date | null;

  /**
   * When the message was created.
   */
  createdAt: Date;
}

/**
 * How many messages the caller has not read yet.
 */
export interface MessageUnreadCount {
  /**
   * The caller's unread messages. Zero means the badge is not drawn.
   */
  count: number;
}

/**
 * The result of changing one message's read state. It carries the new unread
 * count so the badge needs no second request.
 */
export interface MessageReadState extends MessageUnreadCount {
  /**
   * The message whose state changed.
   */
  id: ID;

  /**
   * Its new read timestamp, or null when it was marked unread.
   */
  readAt: Date | null;
}

/**
 * Query shape of the paginated inbox read.
 */
export type MessageListQuery = Pick<PaginatedInputBase, 'limit' | 'offset'>;

/**
 * What it takes to deliver one message to a set of users.
 */
export interface MessageDeliverInput {
  /**
   * What produced it, which decides how `payload` is read.
   */
  kind: MessageKind;

  /**
   * The message's content.
   */
  payload: MessagePayload;

  /**
   * Who receives it. An empty list writes nothing at all.
   */
  userIds: ID[];

  /**
   * The admin who sent it, for a broadcast. Absent for machine-made messages.
   */
  createdByUserId?: ID;
}

/**
 * Who a broadcast reaches. One shape, used by both the send and the preview,
 * so the two can never resolve a different set of people.
 */
export interface MessageBroadcastAudience {
  /**
   * How the audience is chosen, which decides which field below is read.
   */
  audience: AudienceMode;

  /**
   * The recipients, named outright. `explicit_ids` only.
   */
  userIds?: ID[];

  /**
   * Earliest registration date to include, inclusive. `registration_date`
   * only, and optional within it — an open lower bound is a legitimate
   * filter.
   */
  registeredFrom?: string;

  /**
   * Latest registration date to include, exclusive. Optional for the same
   * reason as `registeredFrom`.
   */
  registeredTo?: string;
}

/**
 * The authored content of a broadcast. Ukrainian is required and English is
 * optional — the inbox falls back to the Ukrainian when the author wrote no
 * translation.
 */
export interface MessageBroadcastContent {
  /**
   * The subject line, in Ukrainian.
   */
  subject: string;

  /**
   * The body, in Ukrainian.
   */
  body: string;

  /**
   * The English subject, when the author supplied one.
   */
  subjectEn?: string;

  /**
   * The English body, when the author supplied one.
   */
  bodyEn?: string;

  /**
   * Where the message points, as an app-relative path.
   */
  url?: string;
}

/**
 * A broadcast request: what to send and to whom.
 */
export interface MessageBroadcastInput
  extends MessageBroadcastAudience, MessageBroadcastContent {}

/**
 * How many people an audience resolves to, without sending anything.
 */
export interface MessageBroadcastPreview {
  /**
   * How many active users the filter matched.
   */
  recipients: number;
}

/**
 * What a sent broadcast did.
 */
export interface MessageBroadcastResult extends MessageBroadcastPreview {
  /**
   * The message that was created, or null when the audience was empty.
   */
  messageId: ID | null;
}

/**
 * What one replica tells the others when a user's inbox changes.
 *
 * It deliberately carries no message content: the client refetches, which
 * keeps the event small and means a stale or replayed event can never render
 * anything the reader is not entitled to.
 */
export interface MessageStreamEvent {
  /**
   * Whose inbox changed.
   */
  userId: ID;

  /**
   * The message that arrived, so a client can skip a refetch it already did.
   */
  messageId: ID;

  /**
   * That user's unread count after the change.
   */
  count: number;
}

/**
 * What a broadcast did, plus who it reached.
 *
 * The ids stay inside the server: the domain layer needs them to announce the
 * message on the event stream, and returning them over the wire would hand an
 * admin screen a list of user ids it never asked for.
 */
export interface MessageBroadcastOutcome extends MessageBroadcastResult {
  /**
   * The users the audience resolved to.
   */
  userIds: ID[];
}

/**
 * Request shape for changing one message's read state.
 */
export interface MessageReadInput {
  /**
   * True marks the message read, false returns it to unread.
   */
  read: boolean;
}
