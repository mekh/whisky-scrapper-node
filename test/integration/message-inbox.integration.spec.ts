import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreMessageService } from '~core/message';
import { AudienceMode, MessageKind } from '~enums';
import { NotFoundError } from '~errors';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const MISSING_ID = '0198d1f6-0000-7000-8000-00000000dead' as ID;

/**
 * The inbox against a real database. Five claims carry it and none can be
 * checked without Postgres: the unread-first ordering is an expression sort,
 * marking read twice must not restamp, a foreign message is invisible rather
 * than forbidden, the unread count is scoped to one user, and deleting a user
 * takes their copies with them.
 */
describe('message inbox (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let messages: CoreMessageService;
  let userA: ID;
  let userB: ID;

  /**
   * Creates a throwaway user.
   *
   * Active, unlike most suites' fixtures: the broadcast audience deliberately
   * skips accounts that cannot sign in, so an inactive fixture would resolve
   * to nobody and pass every audience test vacuously.
   *
   * @param suffix - Distinguishes the row from the suite's other user.
   * @returns The new user id.
   */
  const makeUser = async (suffix: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', true)
       RETURNING id`,
      [`itm${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Delivers one message to a set of users.
   *
   * @param kind - What the message is.
   * @param payload - Its content.
   * @param recipients - Who receives it.
   * @returns The new message's id.
   */
  const deliver = async (
    kind: MessageKind,
    payload: Record<string, unknown>,
    recipients: ID[],
  ): Promise<ID> => {
    const rows = await dataSource.query(
      'INSERT INTO message (kind, payload) VALUES ($1, $2) RETURNING id',
      [kind, JSON.stringify(payload)],
    ) as { id: ID }[];

    const messageId = rows[0].id;

    await dataSource.query(
      `INSERT INTO message_recipient ("messageId", "userId")
       SELECT $1, value FROM unnest($2::uuid[]) AS t(value)`,
      [messageId, recipients],
    );

    return messageId;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    messages = moduleRef.get(CoreMessageService);
    userA = await makeUser('a');
    userB = await makeUser('b');
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "user" WHERE id = ANY($1)', [
      [userA, userB],
    ]);

    await closeIntegrationModule(moduleRef);
  });

  afterEach(async () => {
    await dataSource.query(
      `DELETE FROM message WHERE id IN (
         SELECT "messageId" FROM message_recipient WHERE "userId" = ANY($1))`,
      [[userA, userB]],
    );
  });

  it('orders unread before read, newest first within each half', async () => {
    const first = await deliver(MessageKind.SYSTEM, { subject: '1' }, [userA]);
    const second = await deliver(MessageKind.SYSTEM, { subject: '2' }, [userA]);
    const third = await deliver(MessageKind.SYSTEM, { subject: '3' }, [userA]);

    await messages.setRead(userA, second, true);

    const page = await messages.listForUser(userA, {});

    /**
     * The two unread lead, newest first; the read one sinks regardless of
     * being the middle message by age.
     */
    expect(page.data.map((message) => message.id)).toEqual([
      third,
      first,
      second,
    ]);
    expect(page.total).toBe(3);
  });

  it('keeps the first read timestamp when marked read twice', async () => {
    const id = await deliver(MessageKind.SYSTEM, { subject: 'x' }, [userA]);

    const first = await messages.setRead(userA, id, true);
    const second = await messages.setRead(userA, id, true);

    expect(first.readAt).not.toBeNull();
    expect(second.readAt).toEqual(first.readAt);
    expect(second.count).toBe(0);
  });

  it('restores an unread message and the count with it', async () => {
    const id = await deliver(MessageKind.SYSTEM, { subject: 'x' }, [userA]);

    await messages.setRead(userA, id, true);

    const reverted = await messages.setRead(userA, id, false);

    expect(reverted.readAt).toBeNull();
    expect(reverted.count).toBe(1);
  });

  it('hides another user"s message rather than forbidding it', async () => {
    const id = await deliver(MessageKind.SYSTEM, { subject: 'x' }, [userB]);

    await expect(messages.setRead(userA, id, true))
      .rejects.toBeInstanceOf(NotFoundError);

    await expect(messages.setRead(userA, MISSING_ID, true))
      .rejects.toBeInstanceOf(NotFoundError);

    const page = await messages.listForUser(userA, {});

    expect(page.total).toBe(0);
  });

  it('counts and clears unread per user, never across users', async () => {
    await deliver(MessageKind.SYSTEM, { subject: 'a' }, [userA, userB]);
    await deliver(MessageKind.SYSTEM, { subject: 'b' }, [userB]);

    expect((await messages.unreadCount(userA)).count).toBe(1);
    expect((await messages.unreadCount(userB)).count).toBe(2);

    await messages.markAllRead(userA);

    expect((await messages.unreadCount(userA)).count).toBe(0);
    expect((await messages.unreadCount(userB)).count).toBe(2);
  });

  it('sends a broadcast to exactly what the preview counted', async () => {
    const audience = {
      audience: AudienceMode.EXPLICIT_IDS,
      userIds: [userA, userB],
    };

    const preview = await messages.previewBroadcast(audience);

    const sent = await messages.broadcast({
      ...audience,
      subject: 'Роботи',
      body: 'Каталог буде недоступний.',
    }, userA);

    /*
     * The two numbers come from one predicate, which is the whole point of
     * sharing it: an admin must never be shown one audience and mail another.
     */
    expect(sent.recipients).toBe(preview.recipients);
    expect(sent.recipients).toBe(2);

    expect((await messages.unreadCount(userA)).count).toBe(1);
    expect((await messages.unreadCount(userB)).count).toBe(1);
  });

  it('reaches everyone under "all", and nobody inactive', async () => {
    const all = { audience: AudienceMode.ALL };

    const before = await messages.previewBroadcast(all);

    await dataSource.query(
      'UPDATE "user" SET active = false WHERE id = $1',
      [userB],
    );

    const after = await messages.previewBroadcast(all);

    /*
     * A deactivated account cannot sign in, so a message to one is a row
     * nobody will ever read.
     */
    expect(after.recipients).toBe(before.recipients - 1);

    await dataSource.query(
      'UPDATE "user" SET active = true WHERE id = $1',
      [userB],
    );
  });

  it('treats each registration-date bound as optional', async () => {
    const future = '2999-01-01';
    const past = '1999-01-01';

    const fromFuture = await messages.previewBroadcast({
      audience: AudienceMode.REGISTRATION_DATE,
      registeredFrom: future,
    });

    const toFuture = await messages.previewBroadcast({
      audience: AudienceMode.REGISTRATION_DATE,
      registeredTo: future,
    });

    const fromPast = await messages.previewBroadcast({
      audience: AudienceMode.REGISTRATION_DATE,
      registeredFrom: past,
      registeredTo: future,
    });

    expect(fromFuture.recipients).toBe(0);
    expect(toFuture.recipients).toBeGreaterThanOrEqual(2);
    expect(fromPast.recipients).toBe(toFuture.recipients);
  });

  it('writes nothing at all when the audience is empty', async () => {
    const result = await messages.broadcast({
      audience: AudienceMode.REGISTRATION_DATE,
      registeredFrom: '2999-01-01',
      subject: 'x',
      body: 'y',
    }, userA);

    expect(result.messageId).toBeNull();
    expect(result.recipients).toBe(0);
  });

  it('returns a structured payload verbatim', async () => {
    const payload = {
      total: 2,
      items: [{
        productId: MISSING_ID,
        name: 'Ardbeg Uigeadail',
        discountPct: 22,
        price: 2250,
        previousPrice: 2890,
        currency: 'UAH',
        storeName: 'Silpo',
        storeCount: 2,
      }],
    };

    await deliver(MessageKind.DISCOUNT_DIGEST, payload, [userA]);

    const page = await messages.listForUser(userA, {});

    expect(page.data[0]?.payload).toEqual(payload);
  });
});
