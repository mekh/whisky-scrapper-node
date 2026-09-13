import { Injectable } from '@nestjs/common';

import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
import { ID, TypePaginated, TypeSession } from '~types';

@Injectable()
export class AuthSessionService {
  private readonly storage: ValkeyClient | ValkeyCluster;

  private readonly prefix = 'auth:session';

  constructor(redisService: ValkeyService) {
    this.storage = redisService.getClient();
  }

  /**
   * Stores a session and registers it in the user's session index.
   *
   * @param userId - Owner of the session.
   * @param data - The session payload, including its refresh hash.
   * @param expiresEpochMs - Absolute expiry; omit for a session that does not
   *   expire on its own.
   * @returns Resolves once both writes are done.
   */
  public async register(
    userId: ID,
    data: TypeSession,
    expiresEpochMs?: number,
  ): Promise<void> {
    const payload = JSON.stringify(data);
    const key = this.sessionKey(userId, data.sid);
    const tx = this.storage.multi();

    if (expiresEpochMs) {
      tx.set(key, payload, 'PXAT', expiresEpochMs);
    } else {
      tx.set(key, payload);
    }

    await tx.zadd(this.registryKey(userId), expiresEpochMs ?? -1, key).exec();
  }

  /**
   * Reports whether a session is still stored.
   *
   * **This is the hottest call in the application**: every authenticated
   * request runs it inside `AuthJwtGuard`, before any interceptor, so
   * whatever happens here happens to every request — including taking
   * forever.
   *
   * @param userId - Owner of the session.
   * @param sessionId - The session to look for.
   * @returns True when the session exists.
   */
  public async has(userId: ID, sessionId: string): Promise<boolean> {
    const key = this.sessionKey(userId, sessionId);
    const isExists = await this.storage.exists(key);

    return !!isExists;
  }

  /**
   * Loads a stored session.
   *
   * @param userId - Owner of the session.
   * @param sessionId - The session to read.
   * @returns The session, or null when it is gone.
   */
  public async get(
    userId: ID,
    sessionId: string,
  ): Promise<TypeSession | null> {
    const key = this.sessionKey(userId, sessionId);
    const res = await this.storage.get(key);

    return res
      ? JSON.parse(res) as TypeSession
      : null;
  }

  /**
   * Drops one session and removes it from the user's index.
   *
   * @param userId - Owner of the session.
   * @param sessionId - The session to revoke.
   * @returns Resolves once the session is gone.
   */
  public async revoke(userId: ID, sessionId: string): Promise<void> {
    const sessionKey = this.sessionKey(userId, sessionId);

    await this.storage.multi()
      .del(sessionKey)
      .zrem(this.registryKey(userId), sessionKey)
      .exec();
  }

  /**
   * Lists a user's live sessions, sweeping the expired ones first.
   *
   * @param userId - Whose sessions to list.
   * @param limit - Page size.
   * @param page - One-based page number.
   * @returns The page of sessions and the total count.
   */
  public async registry(
    userId: ID,
    limit = 10,
    page = 1,
  ): Promise<TypePaginated<TypeSession>> {
    await this.cleanupObsoleteSessions(userId);

    const offset = (page - 1) * limit;
    const registryKey = this.registryKey(userId);
    const total = await this.storage.zcard(registryKey);
    const keys = await this.storage
      .zrangebyscore(registryKey, -1, '+inf', 'LIMIT', offset, limit);

    const raw = keys.length
      ? await this.storage.mget(keys)
      : [];

    const data = raw.map((item: string | null) =>
      item
        ? JSON.parse(item) as TypeSession
        : null
    ).filter(Boolean) as TypeSession[];

    return { data, total, limit, offset };
  }

  /**
   * Drops every session a user owns.
   *
   * @param userId - Whose sessions to revoke.
   * @returns Resolves once every node has been swept.
   */
  public async revokeAll(userId: ID): Promise<void> {
    const pattern = [this.userKey(userId), '*'].join(':');

    const nodes = this.isCluster(this.storage)
      ? this.storage.nodes('master')
      : [this.storage];

    await Promise.all(
      nodes.map((node) => this.revokeNodeKeys(node, pattern)),
    );
  }

  /**
   * Narrows the client to its cluster form.
   *
   * @param storage - The client to test.
   * @returns True when the client is a cluster client.
   */
  private isCluster(
    storage: ValkeyClient | ValkeyCluster,
  ): storage is ValkeyCluster {
    return storage.isCluster;
  }

  /**
   * Deletes every key matching a pattern on one node.
   *
   * @param node - The node to sweep.
   * @param pattern - Key pattern to match.
   * @returns Resolves once the scan has finished.
   */
  private async revokeNodeKeys(
    node: ValkeyClient,
    pattern: string,
  ): Promise<void> {
    const stream = node.scanStream({
      match: pattern,
      count: 1000,
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (keys: string[]) => {
        if (keys.length) {
          stream.pause();
          node.del(keys).finally(() => stream.resume());
        }
      });

      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Removes the user's expired sessions from their index.
   *
   * @param userId - Whose index to sweep.
   * @returns Resolves once the sweep is done.
   */
  private async cleanupObsoleteSessions(userId: ID): Promise<void> {
    const registryKey = this.registryKey(userId);
    const sessionKeys = await this.storage
      .zrangebyscore(registryKey, 0, Date.now());

    if (!sessionKeys.length) {
      return;
    }

    await this.storage.zrem(registryKey, sessionKeys);
  }

  /**
   * Key of the sorted set indexing one user's sessions.
   *
   * @param userId - The session owner.
   * @returns The registry key.
   */
  private registryKey(userId: ID): string {
    return [this.userKey(userId), 'registry'].join(':');
  }

  /**
   * Key of one stored session.
   *
   * @param userId - The session owner.
   * @param sessionId - The session id.
   * @returns The session key.
   */
  private sessionKey(userId: ID, sessionId: string): string {
    return [this.userKey(userId), sessionId].join(':');
  }

  /**
   * Key prefix shared by everything belonging to one user.
   *
   * @param userId - The owner.
   * @returns The prefix.
   */
  private userKey(userId: ID): string {
    return [this.prefix, userId].join(':');
  }
}
