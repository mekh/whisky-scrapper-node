/**
 * Emits the OpenAPI document to ./openapi.json by fetching it from a running
 * dev server's /docs-json endpoint (which has the @nestjs/swagger plugin
 * applied, so DTO schemas are complete). The document is the input for the web
 * frontend's typed API-client codegen — commit it so codegen needs no backend.
 *
 * Usage: start the API (`pnpm start`), then run `pnpm openapi`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PORT = '4000';
const DEFAULT_HOST = 'localhost';

const run = async (): Promise<void> => {
  const port = process.env.APP_PORT ?? DEFAULT_PORT;
  const host = process.env.APP_HOST ?? DEFAULT_HOST;
  const url = `http://${host}:${port}/docs-json`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status.toString()}`);
  }

  const document: unknown = await response.json();
  const outPath = resolve(process.cwd(), 'openapi.json');

  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);

  console.log(`Wrote OpenAPI document to ${outPath}`);
};

run().catch((error: unknown) => {
  console.error('Failed to emit openapi.json', error);
  process.exit(1);
});
