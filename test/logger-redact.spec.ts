import 'reflect-metadata';

import { Logger, pino } from 'pino';

import { LOG_CENSOR, LOG_REDACT_PATHS } from '~constants';

/**
 * Builds a logger configured exactly as `LoggerModule` configures the real
 * one, writing into an array instead of to stdout.
 *
 * @param lines - Array the logger appends its JSON lines to.
 * @returns The logger under test.
 */
function makeLogger(lines: string[]): Logger {
  return pino(
    {
      level: 'debug',
      redact: { paths: LOG_REDACT_PATHS, censor: LOG_CENSOR },
    },
    { write: (line: string): void => void lines.push(line) },
  );
}

/**
 * Logs one interpolated object the way every `%o` call site in the
 * application does, and returns the resulting line.
 *
 * @param value - The object to interpolate.
 * @returns The rendered log line.
 */
function interpolated(value: object): string {
  const lines: string[] = [];

  makeLogger(lines).debug('data - %o', value);

  return lines[0] ?? '';
}

describe('redaction reaches an interpolated object', () => {
  /**
   * The property of pino this whole list depends on, pinned because it is
   * not obvious: `redact` censors the arguments interpolated into the
   * message, not only the properties of a logged object. Were that ever to
   * change, every `body.*` path below would silently stop protecting
   * anything.
   */
  it('censors a nested path inside a %o argument', () => {
    const line = interpolated({ body: { password: 'hunter2' } });

    expect(line).not.toContain('hunter2');
    expect(line).toContain(LOG_CENSOR);
  });
});

describe('the request dump LogInterceptor writes', () => {
  it('censors a login password', () => {
    const line = interpolated({
      method: 'POST',
      url: '/auth/login',
      body: { login: 'owner', password: 'hunter2' },
      query: {},
      params: {},
    });

    expect(line).not.toContain('hunter2');
    expect(line).toContain('owner');
  });

  it('censors both fields of a password change', () => {
    const line = interpolated({
      body: { oldPassword: 'old-secret', newPassword: 'new-secret' },
    });

    expect(line).not.toContain('old-secret');
    expect(line).not.toContain('new-secret');
  });

  it('censors push subscription key material and endpoint', () => {
    const line = interpolated({
      body: {
        endpoint: 'https://fcm.example/send/abc',
        p256dh: 'public-key-material',
        auth: 'auth-secret',
      },
    });

    expect(line).not.toContain('fcm.example');
    expect(line).not.toContain('public-key-material');
    expect(line).not.toContain('auth-secret');
  });

  it('leaves the rest of a collection body readable', () => {
    const line = interpolated({
      body: { rating: 7.5, notes: 'peat and salt' },
    });

    expect(line).toContain('peat and salt');
  });
});

describe('the response dump LogInterceptor writes', () => {
  /**
   * `POST /auth/login` answers `{ access }` — a bearer token good for the
   * next ten minutes — and the bare key was not on the list before.
   */
  it('censors the access token in a login response', () => {
    const line = interpolated({ access: 'header.payload.signature' });

    expect(line).not.toContain('header.payload.signature');
  });
});

describe('the CLS meta ClsService writes', () => {
  it('censors both tokens when the meta object is logged whole', () => {
    const line = interpolated({
      ip: '203.0.113.7',
      userAgent: 'curl/8',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
    });

    expect(line).not.toContain('access-secret');
    expect(line).not.toContain('refresh-secret');
    expect(line).toContain('203.0.113.7');
  });
});

describe('the error objects the exception filter writes', () => {
  /**
   * Unlike every case above, this one is written at the production log
   * level, from `ExceptionFilter`'s `logger.error(error)`.
   */
  it('censors a failed query bound values but keeps the statement', () => {
    const lines: string[] = [];

    const failure = Object.assign(new Error('numeric field overflow'), {
      parameters: ['a private tasting note', 99999999999],
      query: 'INSERT INTO user_collection (notes) VALUES ($1)',
      driverError: Object.assign(new Error('detail'), {
        detail: 'Key (email)=(owner@example.com) already exists.',
        constraint: 'user_email_uindex',
      }),
    });

    makeLogger(lines).error(failure);

    const line = lines[0] ?? '';

    expect(line).not.toContain('a private tasting note');
    expect(line).not.toContain('owner@example.com');
    expect(line).toContain('INSERT INTO user_collection');
    expect(line).toContain('user_email_uindex');
  });

  it('censors a push error endpoint', () => {
    const lines: string[] = [];

    const failure = Object.assign(new Error('410 Gone'), {
      endpoint: 'https://fcm.example/send/abc',
    });

    makeLogger(lines).error(failure);

    expect(lines[0] ?? '').not.toContain('fcm.example');
  });

  it('censors an outgoing API key carried on a client error', () => {
    const lines: string[] = [];

    const failure = Object.assign(new Error('401 Unauthorized'), {
      headers: { authorization: 'Bearer sk-provider-secret' },
    });

    makeLogger(lines).error(failure);

    expect(lines[0] ?? '').not.toContain('sk-provider-secret');
  });
});
