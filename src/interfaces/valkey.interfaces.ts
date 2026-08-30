/**
 * Connection settings for the Valkey client.
 *
 * The timeout fields are the point of this interface. The client library
 * defaults to waiting forever: a command sent over a socket that has silently
 * died (no `FIN`, no `RST` — a black-holed connection) never resolves and
 * never rejects. Every authenticated request checks its session in Valkey, so
 * "waits forever" there means the whole API stops answering while the process
 * itself looks perfectly healthy.
 */
export interface ValkeySettings {
  /**
   * Hostname of the Valkey server.
   */
  host: string;

  /**
   * Port of the Valkey server.
   */
  port: number;

  /**
   * Logical database index, or undefined to use the server default.
   */
  db: number | undefined;

  /**
   * Password, or undefined when the server takes none.
   */
  password: string | undefined;

  /**
   * Prefix prepended to every key by the client.
   */
  keyPrefix: string;

  /**
   * How long one command may wait for its reply before it is rejected, in
   * milliseconds. This is the timeout whose absence turned a stalled cache
   * into an indefinite outage.
   */
  commandTimeoutMs: number;

  /**
   * How long establishing the TCP connection may take, in milliseconds.
   */
  connectTimeoutMs: number;

  /**
   * TCP keep-alive interval in milliseconds, or 0 to disable. Keep-alive is
   * what lets the kernel discover a peer that vanished without closing the
   * connection, instead of leaving the socket usable-looking forever.
   */
  keepAliveMs: number;

  /**
   * How many times a command is retried while the client is reconnecting
   * before it is rejected. A finite number here is what makes a request fail
   * fast rather than hang through an outage.
   */
  maxRetriesPerRequest: number;

  /**
   * Whether commands issued while the client is disconnected are queued until
   * it reconnects. **False is the safe setting**: a queue that fills during an
   * outage delivers a burst of stale work on recovery, and until then every
   * caller is blocked in it.
   */
  offlineQueue: boolean;
}
