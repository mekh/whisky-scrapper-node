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

    await tx.zadd(
      this.registryKey(userId),
      expiresEpochMs ?? -1,
      key,
    ).exec();
  }

  public async has(userId: ID, sessionId: string): Promise<boolean> {
    const key = this.sessionKey(userId, sessionId);
    const isExists = await this.storage.exists(key);

    return !!isExists;
  }

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

  public async revoke(userId: ID, sessionId: string): Promise<void> {
    const sessionKey = this.sessionKey(userId, sessionId);

    await this.storage.multi()
      .del(sessionKey)
      .zrem(this.registryKey(userId), sessionKey)
      .exec();
  }

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

  public async revokeAll(userId: ID): Promise<void> {
    const pattern = [this.userKey(userId), '*'].join(':');

    const nodes = this.isCluster(this.storage)
      ? this.storage.nodes('master')
      : [this.storage];

    await Promise.all(
      nodes.map((node) => this.revokeNodeKeys(node, pattern)),
    );
  }

  private isCluster(
    storage: ValkeyClient | ValkeyCluster,
  ): storage is ValkeyCluster {
    return storage.isCluster;
  }

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

  private async cleanupObsoleteSessions(userId: ID): Promise<void> {
    const registryKey = this.registryKey(userId);
    const sessionKeys = await this.storage
      .zrangebyscore(registryKey, 0, Date.now());

    if (!sessionKeys.length) {
      return;
    }

    await this.storage.zrem(registryKey, sessionKeys);
  }

  private registryKey(userId: ID): string {
    return [this.userKey(userId), 'registry'].join(':');
  }

  private sessionKey(userId: ID, sessionId: string): string {
    return [this.userKey(userId), sessionId].join(':');
  }

  private userKey(userId: ID): string {
    return [this.prefix, userId].join(':');
  }
}
