import 'reflect-metadata';

import { ReportKind } from '~enums';
import type { CtxUser, ID, ReportFilter, ReportOptions } from '~types';

import { ReportQueryDto } from '../src/domain/report/dto';
import { ReportController } from '../src/domain/report/report.controller';

import type { ReportService } from '../src/domain/report/report.service';

const USER = { id: 'user-1' as ID, sid: 'sid-1' } as CtxUser;

/**
 * Runs the report handler over a mocked service and reports what the service
 * was handed. `toFilter`/`toOptions` are private, so the collaborator's
 * arguments are the only honest way to assert the split.
 *
 * @param query - Query-string fields, already transformed.
 * @returns The filter and options the service received.
 */
async function runReport(
  query: Partial<ReportQueryDto> = {},
): Promise<{ filter: ReportFilter; options: ReportOptions }> {
  const report = jest.fn().mockResolvedValue({ data: [], total: 0 });

  const controller = new ReportController(
    { report } as unknown as ReportService,
  );

  await controller.report(
    USER,
    { kind: ReportKind.CATALOG },
    query as ReportQueryDto,
  );

  const [, filter, options] = report.mock.calls[0] as [
    ReportKind,
    ReportFilter,
    ReportOptions,
  ];

  return { filter, options };
}

describe('ReportController per-user filtering', () => {
  it('keys the report on the authenticated user', async () => {
    const { filter } = await runReport();

    expect(filter.userId).toBe(USER.id);
  });

  it('passes favoritesOnly as a SQL filter, not a JS option', async () => {
    const { filter, options } = await runReport({ favoritesOnly: true });

    expect(filter.favoritesOnly).toBe(true);
    expect(options).not.toHaveProperty('favoritesOnly');
  });

  it('leaves favoritesOnly undefined when the query omits it', async () => {
    const { filter } = await runReport();

    expect(filter.favoritesOnly).toBeUndefined();
  });
});
