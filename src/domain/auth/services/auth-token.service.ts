import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions, JwtVerifyOptions } from '@nestjs/jwt';
import { DecodeOptions } from 'jsonwebtoken';
import crypto from 'node:crypto';

import { JwtAccessConfig } from '~config';
import { Action, Resource } from '~enums';
import { NotAuthenticatedError } from '~errors';
import { AccessJwt, AuthUser, ID, Permission, PermissionMap } from '~types';

interface SessionTokens {
  sid: string;
  access: string;
  refresh: RefreshTokenOut;
}

interface RefreshTokenOut {
  token: string;
  hash: string;
}

interface ParsedRefreshToken {
  /**
   * Id of the user the token belongs to; first segment of the token.
   */
  userId: ID;

  /**
   * Session id the token is bound to; second segment of the token.
   */
  sid: string;

  /**
   * Opaque random secret whose SHA-256 is stored on the session; third
   * segment of the token.
   */
  secret: string;
}

@Injectable()
export class AuthTokenService {
  private resources: Set<string>;

  private actions: Set<string>;

  constructor(
    private readonly accessConfig: JwtAccessConfig,
    private readonly jwtService: JwtService,
  ) {
    this.resources = new Set(Object.values(Resource));
    this.actions = new Set(Object.values(Action));
  }

  public async createSessionTokens(
    user: AuthUser,
    existingSid?: string,
  ): Promise<SessionTokens> {
    const sid = existingSid ?? this.generateId();

    const payload = {
      sub: user.id,
      sid: sid,
    };

    const scope = this.encodeScopes(user.permissions);

    const refresh = this.generateRefreshToken(user.id, sid);
    const access = await this.singAccessToken({
      ...payload,
      admin: user.admin,
      scope,
    });

    return { sid, access, refresh };
  }

  public async verifyAccessToken(
    token: string,
    ignoreExpiration = false,
  ): Promise<AccessJwt> {
    return this.verify<AccessJwt>(token, {
      ...this.accessConfig.verifyOptions,
      ignoreExpiration,
    });
  }

  /**
   * Hashes a refresh token secret for storage/comparison. Uses a plain
   * SHA-256 (no salt) so the same secret always maps to the same hash,
   * which is required to look a token up by its own value.
   *
   * @param secret - The high-entropy random secret part of a refresh token.
   * @returns The base64url-encoded SHA-256 digest of the secret.
   */
  public hashRefreshToken(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('base64url');
  }

  /**
   * Checks a presented refresh secret against a stored hash in constant time.
   *
   * @param secret - The secret extracted from the presented refresh token.
   * @param hash - The hash persisted on the session record.
   * @returns `true` when the secret matches the stored hash.
   */
  public verifyRefreshHash(secret: string, hash: string): boolean {
    const actual = Buffer.from(this.hashRefreshToken(secret));
    const expected = Buffer.from(hash);

    if (actual.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(actual, expected);
  }

  /**
   * Splits a self-describing refresh token into its parts.
   *
   * @param token - The raw refresh token in `userId.sid.secret` form.
   * @returns The parsed parts, or `null` when the token is malformed.
   */
  public parseRefreshToken(token: string): ParsedRefreshToken | null {
    const parts = token.split('.');

    if (parts.length !== 3) {
      return null;
    }

    const [userId, sid, secret] = parts;

    if (!userId || !sid || !secret) {
      return null;
    }

    return { userId, sid, secret };
  }

  public encodeScopes(permissions: Permission[] = []): string {
    const scopes = permissions.reduce(
      (acc, { resource, action }) => acc.add(`${resource}:${action}`),
      new Set<string>(),
    );

    return [...scopes].join(' ');
  }

  public decodeScopes(scope: string): PermissionMap {
    return scope.split(' ').reduce(
      (acc, str) => {
        const [resource, action] = str.split(':') as [Resource, Action];

        if (!this.resources.has(resource) || !this.actions.has(action)) {
          return acc;
        }

        const set = acc.get(resource) ?? new Set();

        return acc.set(resource, set.add(action));
      },
      new Map<Resource, Set<Action>>(),
    );
  }

  protected generateId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  public async sign(
    payload: Record<string, any>,
    options: JwtSignOptions,
  ): Promise<string> {
    return this.jwtService.signAsync(payload, options);
  }

  public decode<T>(token: string, options?: DecodeOptions): T {
    return this.jwtService.decode<T>(token, options);
  }

  public async verify<T extends object>(
    token: string,
    options?: JwtVerifyOptions,
  ): Promise<T> {
    const jwt = await this.jwtService
      .verifyAsync<T>(token, options)
      .catch(() => null);

    if (!jwt) {
      throw new NotAuthenticatedError();
    }

    return jwt;
  }

  protected singAccessToken(payload: AccessJwt): Promise<string> {
    return this.sign(
      payload,
      this.accessConfig.signOptions,
    );
  }

  /**
   * Builds a self-describing refresh token `userId.sid.secret` and the hash
   * of its secret to persist on the session.
   *
   * @param userId - Owner of the session the token authorizes.
   * @param sid - Session id the token is bound to.
   * @returns The raw token handed to the client and the hash to store.
   */
  private generateRefreshToken(userId: ID, sid: string): RefreshTokenOut {
    const secret = crypto.randomBytes(40).toString('base64url');
    const token = [userId, sid, secret].join('.');
    const hash = this.hashRefreshToken(secret);

    return { token, hash };
  }
}
