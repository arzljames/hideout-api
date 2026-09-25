import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { clientEvents, RoomPresence, serverEvents, sharedSchemas } from '../src/contracts/events.js';
import { registry } from '../src/contracts/http/index.js';
import packageJson from '../package.json' with { type: 'json' };

export function buildOpenApiContract(): object {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'hideout-api',
      version: packageJson.version,
      description: 'REST contract for hideout-web. Generated from src/contracts/http; do not edit.',
    },
    servers: [{ url: '/' }],
    security: [{ session: [] }],
  });
}

type EventGroups = Record<string, Record<string, z.ZodType>>;
type JsonSchema = Record<string, unknown>;

/*
 * One document: shared shapes under $defs, events referencing them via $ref.
 * io: 'input' leaves objects open (no additionalProperties: false), so hideout-web
 * validators accept fields added later, which keeps additive changes non-breaking.
 */
export function buildEventsContract(): object {
  const reg = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(sharedSchemas)) reg.add(schema, { id });

  const groups = { serverEvents, clientEvents } as Record<string, EventGroups>;
  for (const [group, kinds] of Object.entries(groups)) {
    for (const [kind, events] of Object.entries(kinds)) {
      for (const [name, schema] of Object.entries(events)) reg.add(schema, { id: `${group}/${kind}/${name}` });
    }
  }
  reg.add(RoomPresence, { id: 'RoomPresence' });

  const { schemas } = z.toJSONSchema(reg, { io: 'input', uri: (id) => `#/$defs/${id}` });
  const clean = (id: string): JsonSchema => {
    const { $schema, $id, ...rest } = schemas[id] as JsonSchema;
    return rest;
  };

  const eventsOf = (group: string) =>
    Object.fromEntries(
      Object.entries(groups[group] ?? {}).map(([kind, events]) => [
        kind,
        Object.fromEntries(Object.keys(events).map((name) => [name, clean(`${group}/${kind}/${name}`)])),
      ]),
    );

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment: 'Realtime contract for hideout-web. Generated from src/contracts/events.ts; do not edit.',
    version: packageJson.version,
    topics: {
      // clientsMay = what browsers may send on the topic (enforced by realtime.messages RLS).
      room: {
        pattern: 'room:<roomId>',
        private: true,
        clientsMay: { broadcast: false, presence: true },
        presence: { $ref: '#/$defs/RoomPresence' },
      },
      channel: { pattern: 'channel:<channelId>', private: true, clientsMay: { broadcast: false, presence: false } },
      typing: { pattern: 'typing:<channelId>', private: true, clientsMay: { broadcast: true, presence: false } },
      user: { pattern: 'user:<profileId>', private: true, clientsMay: { broadcast: false, presence: false } },
    },
    serverEvents: eventsOf('serverEvents'),
    clientEvents: eventsOf('clientEvents'),
    $defs: Object.fromEntries([...Object.keys(sharedSchemas), 'RoomPresence'].map((id) => [id, clean(id)])),
  };
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
