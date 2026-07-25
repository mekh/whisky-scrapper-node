import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

import { createClient, politeSleep } from './clients';
import { PROBES } from './probes';

import type {
  SpikeAttempt,
  SpikeCliArgs,
  SpikeClientKind,
  SpikePlanEntry,
  SpikeProbe,
  SpikeProbeContext,
  SpikeVerdict,
} from './spike.interfaces';

const CLIENT_KINDS: SpikeClientKind[] = ['plain', 'impit', 'playwright'];
const DEFAULT_PAGES = 2;
const DEFAULT_REPEAT = 3;
const IP_CHECK_URL = 'https://api.ipify.org?format=json';
const IP_CHECK_TIMEOUT_MS = 8_000;

/**
 * Default matrix: cheapest viable client first, escalating where a stronger
 * client may be required. Escalation is enabled for every HTML store, not
 * just the ones the Python scraper flagged: the datacenter-IP run showed
 * `winewine` — which nothing marked as protected — 403s on plain `fetch`
 * while `goodwine` passes, so which store needs impersonation cannot be
 * predicted from the old code's notes.
 */
const DEFAULT_PLAN: SpikePlanEntry[] = [
  { slug: 'metro', clients: ['plain'], escalate: false },
  { slug: 'novus', clients: ['plain'], escalate: false },
  { slug: 'maudau', clients: ['plain'], escalate: false },
  { slug: 'okwine', clients: ['plain'], escalate: false },
  {
    slug: 'winewine',
    clients: ['plain', 'impit', 'playwright'],
    escalate: true,
  },
  {
    slug: 'wine-point',
    clients: ['plain', 'impit', 'playwright'],
    escalate: true,
  },
  {
    slug: 'goodwine',
    clients: ['plain', 'impit', 'playwright'],
    escalate: true,
  },
  { slug: 'rozetka', clients: ['playwright'], escalate: false },
];

/**
 * Prints one line to stdout.
 *
 * @param message - Text to print.
 */
const say = (message: string): void => {
  stdout.write(`${message}\n`);
};

/**
 * Reads a `--flag value` pair from the argument list.
 *
 * @param args - Raw CLI arguments.
 * @param flag - Flag name including the leading dashes.
 * @returns The value, or null when the flag is absent or has no value.
 */
const flagValue = (args: string[], flag: string): string | null => {
  const index = args.indexOf(flag);

  if (index === -1 || index === args.length - 1) {
    return null;
  }

  return args[index + 1];
};

/**
 * Parses CLI arguments, expanding `--store all` (or an omitted store) to the
 * default plan's slugs.
 *
 * @param args - Raw CLI arguments (without the node/script entries).
 * @returns The parsed arguments.
 * @throws {Error} When a slug or client kind is unknown.
 */
const parseArgs = (args: string[]): SpikeCliArgs => {
  const storeArg = flagValue(args, '--store') ?? 'all';
  const clientArg = flagValue(args, '--client');

  const stores = storeArg === 'all'
    ? DEFAULT_PLAN.map((entry) => entry.slug)
    : storeArg.split(',').map((slug) => slug.trim()).filter(Boolean);

  const unknown = stores.filter((slug) => !(slug in PROBES));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown store(s): ${unknown.join(', ')}. `
        + `Known: ${Object.keys(PROBES).join(', ')}`,
    );
  }

  if (clientArg && !CLIENT_KINDS.includes(clientArg as SpikeClientKind)) {
    throw new Error(
      `Unknown client "${clientArg}". Known: ${CLIENT_KINDS.join(', ')}`,
    );
  }

  return {
    stores,
    client: (clientArg as SpikeClientKind | null) ?? null,
    pages: Number(flagValue(args, '--pages') ?? DEFAULT_PAGES),
    repeat: Number(flagValue(args, '--repeat') ?? DEFAULT_REPEAT),
    soakMinutes: Number(flagValue(args, '--soak') ?? 0),
    out: flagValue(args, '--out'),
  };
};

/**
 * Reports the current public IP so a run can be attributed to a residential
 * or datacenter address — the whole point of the VPN phase.
 *
 * @returns The IP address, or `unknown` when the lookup failed.
 */
const publicIp = async (): Promise<string> => {
  try {
    const response = await fetch(IP_CHECK_URL, {
      signal: AbortSignal.timeout(IP_CHECK_TIMEOUT_MS),
    });

    const payload = await response.json() as { ip?: string };

    return payload.ip ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * Runs one attempt of a probe over a freshly created client, so each attempt
 * looks like a separate collector run rather than a reused session.
 *
 * @param probe - The store probe to run.
 * @param client - Which transport to build for this attempt.
 * @param pages - Maximum listing pages to fetch.
 * @param attempt - 1-based attempt number, used for log prefixes.
 * @returns The attempt outcome.
 */
const runAttempt = async (
  probe: SpikeProbe,
  client: SpikeClientKind,
  pages: number,
  attempt: number,
): Promise<SpikeAttempt> => {
  const startedAt = Date.now();
  const transport = await createClient(client, probe.delayRange);

  const ctx: SpikeProbeContext = {
    get: transport.get.bind(transport),
    evaluate: transport.evaluate?.bind(transport),
    sleep: () => politeSleep(probe.delayRange),
    log: (message) => {
      say(`    [${probe.slug}/${client}#${attempt}] ${message}`);
    },
  };

  try {
    const result = await probe.run(ctx, pages);

    return {
      attempt,
      ok: result.items > 0 && !result.challenged,
      durationMs: Date.now() - startedAt,
      result,
      error: null,
    };
  } catch (error) {
    return {
      attempt,
      ok: false,
      durationMs: Date.now() - startedAt,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await transport.close();
  }
};

/**
 * Runs a series of attempts for one store x client pair: either a fixed
 * repeat count (quick pass) or a time-boxed soak.
 *
 * @param probe - The store probe to run.
 * @param client - Which transport to use.
 * @param args - Parsed CLI arguments.
 * @returns The aggregated verdict for this pair.
 */
const runSeries = async (
  probe: SpikeProbe,
  client: SpikeClientKind,
  args: SpikeCliArgs,
): Promise<SpikeVerdict> => {
  const deadline = args.soakMinutes > 0
    ? Date.now() + args.soakMinutes * 60_000
    : 0;

  const attempts: SpikeAttempt[] = [];
  let attempt = 0;

  say(`  ${probe.slug} via ${client}`);

  while (deadline > 0 ? Date.now() < deadline : attempt < args.repeat) {
    attempt += 1;

    const outcome = await runAttempt(probe, client, args.pages, attempt);

    attempts.push(outcome);

    say(
      `    -> ${outcome.ok ? 'ok' : 'FAIL'} `
        + `items=${outcome.result?.items ?? 0} `
        + `inStock=${outcome.result?.inStock ?? 0} `
        + `statuses=${outcome.result?.statuses.join('/') ?? '-'} `
        + `challenged=${String(outcome.result?.challenged ?? false)} `
        + `${Math.round(outcome.durationMs / 100) / 10}s`
        + `${outcome.error ? ` error=${outcome.error}` : ''}`,
    );

    if (outcome.result?.sample) {
      say(`       sample: ${outcome.result.sample}`);
    }

    const goingAgain = deadline > 0
      ? Date.now() < deadline
      : attempt < args.repeat;

    if (goingAgain) {
      await politeSleep(probe.delayRange);
    }
  }

  return {
    slug: probe.slug,
    client,
    pass: attempts.length > 0 && attempts.every((item) => item.ok),
    attempts,
  };
};

/**
 * Resolves which clients to try for a store: the forced one, this store's
 * planned escalation chain, or whatever the probe supports.
 *
 * @param probe - The store probe.
 * @param args - Parsed CLI arguments.
 * @returns Clients in the order they should be attempted.
 * @throws {Error} When a forced client is not supported by the probe.
 */
const clientsFor = (
  probe: SpikeProbe,
  args: SpikeCliArgs,
): SpikeClientKind[] => {
  if (args.client) {
    if (!probe.supported.includes(args.client)) {
      throw new Error(
        `Store ${probe.slug} does not support the ${args.client} client `
          + `(supported: ${probe.supported.join(', ')})`,
      );
    }

    return [args.client];
  }

  const planned = DEFAULT_PLAN.find((entry) => entry.slug === probe.slug);

  return planned ? planned.clients : probe.supported;
};

/**
 * Runs the whole matrix and prints a summary table.
 *
 * @param args - Parsed CLI arguments.
 * @returns Every verdict produced, in run order.
 */
const runMatrix = async (args: SpikeCliArgs): Promise<SpikeVerdict[]> => {
  const verdicts: SpikeVerdict[] = [];

  for (const slug of args.stores) {
    const probe = PROBES[slug];
    const planned = DEFAULT_PLAN.find((entry) => entry.slug === slug);
    const escalate = !args.client && (planned?.escalate ?? false);

    for (const client of clientsFor(probe, args)) {
      const verdict = await runSeries(probe, client, args);

      verdicts.push(verdict);

      if (escalate && verdict.pass) {
        say(`  ${slug}: ${client} passed, skipping stronger clients`);

        break;
      }
    }
  }

  return verdicts;
};

/**
 * Prints the final matrix as a compact table.
 *
 * @param verdicts - Verdicts to summarize.
 */
const printSummary = (verdicts: SpikeVerdict[]): void => {
  say('');
  say('=== spike summary ===');

  verdicts.forEach((verdict) => {
    const ok = verdict.attempts.filter((attempt) => attempt.ok).length;
    const items = Math.max(
      ...verdict.attempts.map((attempt) => attempt.result?.items ?? 0),
    );

    const errors = verdict.attempts
      .map((attempt) => attempt.error)
      .filter((error): error is string => error !== null);

    const lastError = errors.length > 0 ? errors[errors.length - 1] : null;

    say(
      `${verdict.pass ? 'PASS' : 'FAIL'}  `
        + `${verdict.slug.padEnd(12)} ${verdict.client.padEnd(11)} `
        + `${ok}/${verdict.attempts.length} attempts  items=${items}`
        + `${lastError ? `  last error: ${lastError}` : ''}`,
    );
  });
};

/**
 * Entry point: parses arguments, runs the matrix, prints and optionally saves
 * the report.
 *
 * @returns Resolves with the process exit code (1 when any verdict failed).
 */
const main = async (): Promise<number> => {
  const args = parseArgs(argv.slice(2));
  const ip = await publicIp();

  say(`public IP: ${ip}`);
  say(
    `stores: ${args.stores.join(', ')} | pages=${args.pages} `
      + `| ${
        args.soakMinutes > 0
          ? `soak=${args.soakMinutes}min`
          : `repeat=${args.repeat}`
      }`,
  );
  say('');

  const verdicts = await runMatrix(args);

  printSummary(verdicts);

  if (args.out) {
    writeFileSync(
      args.out,
      `${JSON.stringify({ ip, args, verdicts }, null, 2)}\n`,
      'utf8',
    );

    say(`report written to ${args.out}`);
  }

  return verdicts.every((verdict) => verdict.pass) ? 0 : 1;
};

if (require.main === module) {
  main()
    .then((code) => exit(code))
    .catch((error: unknown) => {
      console.error(error);

      exit(1);
    });
}
