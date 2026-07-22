import { Injectable } from '@nestjs/common';

import { AuthConfig } from '~config';
import { CoreUserService } from '~core/user';
import { NotAuthenticatedError, NotAuthorizedError } from '~errors';
import {
  AuthLoginInput,
  AuthTokens,
  AuthUser,
  CtxUser,
  ID,
  TypePaginated,
  TypeSession,
} from '~types';
import { Hash } from '~utils';

import { AuthSessionService } from './services/auth-session.service';
import { AuthTokenService } from './services/auth-token.service';

interface GenerateTokensInput {
  user: AuthUser;
  ip: string;
  userAgent: string;
  sid?: string;
}

interface RefreshInput {
  refreshToken: string;
  ip: string;
  userAgent: string;
}

interface VerifyPassword {
  password: string;
  hash: string;
  errorMessage?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tokenService: AuthTokenService,
    private readonly session: AuthSessionService,
    private readonly config: AuthConfig,
    private readonly users: CoreUserService,
  ) {}

  public async login(input: AuthLoginInput): Promise<AuthTokens> {
    const { login, password, ip, userAgent } = input;
    const isEmail = login.indexOf('@') >= 1;

    const query = isEmail
      ? { email: login }
      : { name: login };

    const user = await this.users.getAuthInfo(query);
    const errorMessage = 'Invalid name or password';
    if (!user) {
      throw new NotAuthenticatedError(errorMessage);
    }

    if (!user.active) {
      throw new NotAuthorizedError();
    }

    await this.verifyPassword({
      password,
      hash: user.password,
      errorMessage: 'Invalid name or password',
    });

    await this.upgradeHashIfNeeded(user.id, user.password, password);

    return this.createSession({ user, ip, userAgent });
  }

  /**
   * Rotates a session's tokens from a valid refresh token: verifies the
   * token against the session, then issues a fresh access/refresh pair and
   * invalidates the presented one.
   *
   * @param input - The presented refresh token plus current ip/user-agent.
   * @returns A new access/refresh pair bound to the same session id.
   * @throws {NotAuthenticatedError} When the token is malformed, unknown,
   *   does not match the session, or the user is missing/inactive.
   */
  public async refresh(input: RefreshInput): Promise<AuthTokens> {
    const { refreshToken, ip, userAgent } = input;

    const parsed = this.tokenService.parseRefreshToken(refreshToken);

    if (!parsed) {
      throw new NotAuthenticatedError();
    }

    const session = await this.session.get(parsed.userId, parsed.sid);

    if (!session) {
      throw new NotAuthenticatedError();
    }

    const valid = this.tokenService.verifyRefreshHash(
      parsed.secret,
      session.refreshHash,
    );

    if (!valid) {
      throw new NotAuthenticatedError();
    }

    const user = await this.users.getAuthInfo({ id: parsed.userId });

    if (!user || !user.active) {
      await this.session.revoke(parsed.userId, parsed.sid);

      throw new NotAuthenticatedError();
    }

    return this.createSession({ user, ip, userAgent, sid: parsed.sid });
  }

  public async logout(user: CtxUser, sessionId: string): Promise<void> {
    await this.session.revoke(user.id, sessionId);
  }

  public async authenticate(accessJwt: string): Promise<CtxUser> {
    const jwt = await this.tokenService.verifyAccessToken(accessJwt);
    const permissions = this.tokenService.decodeScopes(jwt.scope);

    await this.validateSession(jwt.sub, jwt.sid);

    return {
      id: jwt.sub,
      sid: jwt.sid,
      admin: jwt.admin,
      permissions,
    };
  }

  /**
   * Issues a session: mints the token pair, persists the session with the
   * refresh hash, and returns the tokens. Reused for both login and refresh
   * — pass `data.sid` to rotate an existing session in place.
   *
   * @param data - The authenticated user, request ip/user-agent, and an
   *   optional existing session id to reuse.
   * @returns The access token and the raw refresh token for the client.
   */
  public async createSession(data: GenerateTokensInput): Promise<AuthTokens> {
    const {
      sid,
      access,
      refresh,
    } = await this.tokenService.createSessionTokens(data.user, data.sid);

    const { refreshExpiresInSec } = this.config;
    const expiresEpochMs = Date.now() + refreshExpiresInSec * 1000;

    const payload: TypeSession = {
      sid,
      ip: data.ip,
      userAgent: data.userAgent,
      expires: expiresEpochMs,
      refreshHash: refresh.hash,
    };

    await this.session.register(data.user.id, payload, expiresEpochMs);

    return { access, refresh: refresh.token };
  }

  public async getSessions(
    userId: ID,
    limit?: number,
    page?: number,
  ): Promise<TypePaginated<TypeSession>> {
    return this.session.registry(userId, limit, page);
  }

  public async revokeSession(userId: ID, sessionId: string): Promise<void> {
    await this.session.revoke(userId, sessionId);
  }

  protected async validateSession(
    userId: ID,
    sessionId: string,
  ): Promise<void> {
    const exist = await this.session.has(userId, sessionId);

    if (!exist) {
      await this.session.revokeAll(userId);

      throw new NotAuthenticatedError();
    }
  }

  private async verifyPassword({
    password,
    hash,
    errorMessage,
  }: VerifyPassword): Promise<void> {
    const res = await Hash.verifyAsync(password, hash);

    if (!res) {
      throw new NotAuthenticatedError(errorMessage ?? 'Password missmatch');
    }
  }

  /**
   * Upgrades a legacy pbkdf2 password hash to Argon2 after a successful
   * login, so migrated users are transparently re-hashed on first use.
   *
   * @param id - Id of the user whose hash may need upgrading.
   * @param storedHash - The hash currently stored for the user.
   * @param password - The verified plaintext password to re-hash.
   * @returns Resolves once any needed upgrade has been persisted.
   */
  private async upgradeHashIfNeeded(
    id: ID,
    storedHash: string,
    password: string,
  ): Promise<void> {
    if (!Hash.needsRehash(storedHash)) {
      return;
    }

    await this.users.changePassword(id, password);
  }
}
