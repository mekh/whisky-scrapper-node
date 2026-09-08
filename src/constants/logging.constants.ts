/**
 * What replaces a redacted value.
 */
export const LOG_CENSOR = '***';

/**
 * Paths pino's `redact` option censors.
 *
 * **What redaction reaches, verified rather than assumed:** both the
 * properties of a logged object *and* the properties of an object
 * interpolated into the message with `%o`. The second half is the one worth
 * knowing, because almost every log call in this application is the
 * interpolated kind — the logger hook renders a `%o` argument into `msg` —
 * and a path that looks dead is therefore live. A path is matched against
 * the object it is given, so `body.password` matches the request dump
 * `{ body, query, params, url, method }` that `LogInterceptor` logs, and a
 * bare `accessToken` matches the CLS meta object `ClsService` logs whole.
 *
 * **The one thing redaction cannot reach is a value already inside a
 * string.** That is why `DbQueryLogger` exists rather than a path: TypeORM
 * appends `-- PARAMETERS: [...]` to the statement text itself, so by the
 * time any logger sees it the values are prose.
 *
 * Whoever adds a log call that carries an object — or a field to a DTO whose
 * body is logged — checks this list. The grouping below is the map of what
 * is already covered.
 */
export const LOG_REDACT_PATHS = [
  /**
   * Credentials arriving in a request body, which `LogInterceptor` dumps at
   * `debug`: `POST /auth/login`, `POST /user`, `POST /user/password`.
   */
  'body.password',
  'body.oldPassword',
  'body.newPassword',

  /**
   * Push subscription key material and the endpoint, from
   * `POST`/`DELETE /push/subscription`. The endpoint is a bearer capability
   * for pushing to that browser, not merely an address.
   */
  'body.endpoint',
  'body.p256dh',
  'body.auth',
  'body.keys',

  /**
   * Tokens in an outgoing payload, which the same interceptor dumps at
   * `verbose`. `access` is the bare key `POST /auth/login` and
   * `POST /auth/refresh` answer with — the response that hands out a
   * bearer token for the next ten minutes.
   */
  'access',
  'accessToken',
  'access.token',
  'refresh',
  'refreshToken',
  'refresh.token',
  'token',
  'password',

  /**
   * The CLS request meta, logged whole by `ClsService.setMeta`/`getMeta`,
   * plus the same fields one level down for anything that nests it.
   */
  'meta.accessToken',
  'meta.refreshToken',
  'ctx.accessToken',
  'ctx.refreshToken',

  /**
   * Headers, wherever a logged object carries them.
   */
  'authorization',
  'cookie',
  'headers.authorization',
  'headers.cookie',

  /**
   * Error objects. The global exception filter logs a bare `Error`, which
   * pino serializes under `err`, and unlike everything above these lines
   * are written at the production log level.
   *
   * - `err.parameters` — a TypeORM `QueryFailedError` carries the failed
   *   statement's bound values, so the insert that overflowed on a purchase
   *   price logs the price, and the one that failed on a tasting note logs
   *   the note.
   * - `err.driverError.detail` — PostgreSQL echoes the offending values into
   *   a constraint violation's detail line (`Key (email)=(...) already
   *   exists`). `err.driverError.constraint` stays visible, and that is what
   *   debugging a duplicate actually needs.
   * - `err.endpoint` — a `WebPushError` names the push endpoint.
   * - the `authorization` triplet — an HTTP client error (the LLM SDK's most
   *   of all) can carry the outgoing request's headers, and that header is
   *   the provider API key.
   *
   * `err.query` is deliberately absent: the statement text is the most
   * useful line in a database failure and holds no data of its own.
   */
  'err.parameters',
  'err.driverError.detail',
  'err.endpoint',
  'err.headers.authorization',
  'err.request.headers.authorization',
  'err.config.headers.authorization',
];
