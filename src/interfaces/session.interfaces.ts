import { ID } from './entity.interfaces';

export interface TypeSession {
  sid: string;
  ip: string;
  userAgent: string;
  expires: number;

  /**
   * SHA-256 (base64url) of the refresh token secret bound to this session.
   * Rotated on every refresh. Never exposed in API responses — stripped by
   * the response DTO whitelist, the same way the user password hash is.
   */
  refreshHash: string;
}

export type TypeSessionPublic = Omit<TypeSession, 'refreshHash'>;

export interface SessionQuery {
  /**
   * Maximum number of sessions to return in one page.
   */
  limit?: number;

  /**
   * One-based page number to return.
   */
  page?: number;
}

export interface SessionParams {
  /**
   * Id of the user whose session is targeted.
   */
  userId: ID;

  /**
   * Session id (`sid`) to operate on.
   */
  sid: string;
}

export type SessionOwnerParams = Partial<Pick<SessionParams, 'userId'>>;
