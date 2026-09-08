/**
 * Resolves which address a request actually came from, for decisions that
 * have to be right rather than merely informative — a rate-limit bucket, a
 * login-attempt ladder, a session record.
 *
 * Every candidate is a request header, and a request header is client input
 * until a proxy overwrites it, so the list of headers to consult is a
 * deployment fact rather than a code constant: it comes from
 * `APP_TRUSTED_IP_HEADERS`, defaulting to
 * {@link DEFAULT_TRUSTED_IP_HEADERS}. An empty list means no header is
 * believed at all, which is the correct setting wherever the process is
 * reachable without a proxy in front of it.
 *
 * **Only the last hop of a header is read.** nginx sets `X-Forwarded-For`
 * with `$proxy_add_x_forwarded_for`, which *appends*: a client sending
 * `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real peer>`, so the head of
 * that chain is an attacker-chosen string and the tail is the address the
 * proxy accepted. Reading the header whole, or its first entry, would let one
 * caller choose its own identity — defeating any limit keyed on it and
 * letting it grow the limiter's bucket map on demand. A replace-style header
 * such as `X-Real-IP` or `CF-Connecting-IP` carries a single hop, so the same
 * rule returns its value unchanged.
 */
export class ClientIpUtils {
  /**
   * Picks the client address out of the headers the deployment trusts.
   *
   * @param headers - The request's headers, names already lower-cased by
   *   Fastify.
   * @param fallback - The connection's own address (`req.ip`): correct with
   *   no proxy in front, and the proxy's own address behind one, which is why
   *   it is the fallback rather than the answer.
   * @param trustedHeaders - Header names to consult, in order of trust. An
   *   empty list disables header resolution entirely.
   * @returns The resolved address; `fallback` when no trusted header carries
   *   one.
   */
  public static resolve(
    headers: Record<string, string | string[] | undefined>,
    fallback: string,
    trustedHeaders: readonly string[],
  ): string {
    const resolved = trustedHeaders.reduce<string | null>(
      (found, header) => found ?? ClientIpUtils.lastHop(headers[header]),
      null,
    );

    return resolved ?? fallback;
  }

  /**
   * Takes the last hop of one header value — the entry the nearest proxy
   * appended, and the only one it vouches for.
   *
   * @param value - The raw header value; an array when the header repeated.
   * @returns The last non-blank hop, or null when the header is absent or
   *   carries nothing.
   */
  private static lastHop(
    value: string | string[] | undefined,
  ): string | null {
    const raw = Array.isArray(value) ? value.at(-1) : value;

    const hops = (raw ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);

    return hops.at(-1) ?? null;
  }
}
