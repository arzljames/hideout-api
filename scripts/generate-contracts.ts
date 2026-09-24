import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEventsContract, buildOpenApiContract, serialize } from './contracts.js';

const outDir = fileURLToPath(new URL('../contract/', import.meta.url));

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'openapi.json'), serialize(buildOpenApiContract()));
await writeFile(join(outDir, 'events.schema.json'), serialize(buildEventsContract()));

process.stdout.write('Wrote contract/openapi.json and contract/events.schema.json\n');
