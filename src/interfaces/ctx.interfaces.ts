import { ID } from './entity.interfaces';
import { PermissionMap } from './permission.interfaces';

export interface CtxUser {
  id: ID;
  sid: string;
  admin?: boolean;
  permissions?: PermissionMap;
}

export interface CtxMeta {
  ip?: string;
  user?: CtxUser | null;
  userAgent?: string;
  accessToken?: string;
  refreshToken?: string;
  sessionId?: string;
}

export type CtxReqMixin = CtxMeta;

export interface CtxManager<TCtx = any> {
  user: CtxUser | null;
  sessionId: string | undefined;
  ip: string;
  userAgent: string;
  getData<T = unknown>(): T;
  getContext(): TCtx;
  getAccessToken(): string | undefined;
  getRefreshToken(): string | undefined;
}
