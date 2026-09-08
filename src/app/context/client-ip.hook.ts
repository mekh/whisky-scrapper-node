import { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { FastifyRequest } from 'fastify';

import { AppConfig } from '~config';
import type { CtxReqMixin } from '~types';
import { ClientIpUtils } from '~utils';

/**
 * Decides which address a request came from, once, before anything reads it.
 *
 * It is the **single** definition of who a caller is: whatever it writes to
 * `req.ctx.ip` is what `@ReqIp()`, the session records, the rate limiter and
 * the login ladder all go on to use. That mattered enough to centralise,
 * because there used to be three answers — the CLS setup took the first of
 * four headers raw, two of which nothing in the stack sets *or strips*
 * (`x-client-ip`, `cf-connecting-ip`), so a caller could put any address it
 * liked into its own session record; `HttpContextManager.ip` ignored the
 * headers and answered the proxy's address; and the rate limiter had its own
 * copy again. `ClientIpUtils` documents which headers are believed and why
 * only their last hop is read.
 *
 * A Fastify `onRequest` hook and **not** Nest middleware, which is where
 * this was first written and did not work: on Fastify, Nest middleware runs
 * through `middie` and is handed the raw `IncomingMessage`, while a guard or
 * a param decorator is handed the Fastify `Request` wrapping it. Writing
 * `ctx` on the former leaves the latter untouched — a hook is the earliest
 * place that sees the same object the rest of the request does.
 *
 * @param app - The application to install the hook on, before it listens.
 * @param config - Which headers may be believed, and whether any may.
 */
export const registerClientIpHook = (
  app: NestFastifyApplication,
  config: AppConfig,
): void => {
  const headers = config.clientIpHeaders;

  app.getHttpAdapter().getInstance().addHook(
    'onRequest',
    (request: FastifyRequest, _reply, done): void => {
      const req = request as FastifyRequest & { ctx?: CtxReqMixin };

      req.ctx = {
        ...req.ctx,
        ip: ClientIpUtils.resolve(request.headers, request.ip, headers),
      };

      done();
    },
  );
};
