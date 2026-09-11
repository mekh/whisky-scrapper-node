import 'reflect-metadata';

import { ReportKind } from '~enums';
import type {
  CtxUser,
  ID,
  ReportFilter,
  ReportOptions,
  ReportPersonalization,
} from '~types';

import { ReportQueryDto } from '../src/domain/report/dto';
import { ReportController } from '../src/domain/report/report.controller';

import type { ReportService } from '../src/domain/report/report.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

/**
 * Runs the report handler over a mocked service and reports what the service
 * was handed. `toFilter`/`toOptions`/`toPersonalization` are private, so the
 * collaborator's arguments are the only honest way to assert the split.
 *
 * @param query - Query-string fields, already transformed.
 * @returns The three argument groups the service received.
 */
async function runReport(
  query: Partial<ReportQueryDto> = {},
): Promise<{
  filter: ReportFilter;
  options: ReportOptions;
  personalization: ReportPersonalization;
}> {
  const report = jest.fn().mockResolvedValue({ data: [], total: 0 });

  const controller = new ReportController(
    { report } as unknown as ReportService,
  );

  await controller.report(
    USER,
    { kind: ReportKind.CATALOG },
    query as ReportQueryDto,
  );

  const [, filter, options, personalization] = report.mock.calls[0] as [
    ReportKind,
    ReportFilter,
    ReportOptions,
    ReportPersonalization,
  ];

  return { filter, options, personalization };
}

describe('ReportController per-user filtering', () => {
  it('keys the report on the authenticated user', async () => {
    const { personalization } = await runReport();

    expect(personalization.userId).toBe(USER.id);
  });

  it('keeps the user out of the catalogue filter entirely', async () => {
    /**
     * The filter is what a shared cache would be keyed by, so a user id
     * reaching it is the defect this split exists to prevent — one user's
     * catalogue served to the next.
     */
    const { filter, options } = await runReport({ favoritesOnly: true });

    expect(filter).not.toHaveProperty('userId');
    expect(filter).not.toHaveProperty('favoritesOnly');
    expect(options).not.toHaveProperty('favoritesOnly');
  });

  it('passes favoritesOnly as personalization', async () => {
    const { personalization } = await runReport({ favoritesOnly: true });

    expect(personalization.favoritesOnly).toBe(true);
  });

  it('leaves favoritesOnly undefined when the query omits it', async () => {
    const { personalization } = await runReport();

    expect(personalization.favoritesOnly).toBeUndefined();
  });
});
