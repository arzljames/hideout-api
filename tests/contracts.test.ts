import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildEventsContract, buildOpenApiContract, serialize } from '../scripts/contracts.js';

async function committed(file: string): Promise<string> {
  return (await readFile(new URL(`../contract/${file}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
}

describe('generated contracts', () => {
  it('contract/openapi.json is up to date (run `npm run contracts`)', async () => {
    expect(await committed('openapi.json')).toBe(serialize(buildOpenApiContract()));
  });

  it('contract/events.schema.json is up to date (run `npm run contracts`)', async () => {
    expect(await committed('events.schema.json')).toBe(serialize(buildEventsContract()));
  });
});
