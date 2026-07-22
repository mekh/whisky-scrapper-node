import { CookieSerializeOptions } from '@fastify/cookie';
import { FastifyReply as Response, FastifyRequest } from 'fastify';
import { FastifyBaseLogger } from 'fastify/types/logger';
import { RouteGenericInterface } from 'fastify/types/route';
import { FastifySchema } from 'fastify/types/schema';
import {
  FastifyRequestType,
  FastifyTypeProviderDefault,
} from 'fastify/types/type-provider';
import {
  ContextConfigDefault,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify/types/utils';

import { CtxReqMixin } from './ctx.interfaces';

export type Request<P = any, B = any, Q = any> = FastifyRequest<
  RouteGenericInterface,
  RawServerDefault,
  RawRequestDefaultExpression,
  FastifySchema,
  FastifyTypeProviderDefault,
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyRequestType<P, Q, Record<string, string>, B>
>;

export interface Req<P = any, B = any, Q = any> extends Request<P, B, Q> {
  ctx?: CtxReqMixin;
}

export { type Response };
export type CookieOptions = CookieSerializeOptions;
