import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiContract } from '../scripts/contracts.js';
import { sharedSchemas } from '../src/contracts/events.js';

/*
 * src/contracts/http/rooms.ts re-registers the shared shapes from events.ts as OpenAPI
 * components (from clones, with nested shared shapes swapped for their registered copies).
 * This checks the REST copy can't drift from the realtime original: same property keys and
 * `required` lists, recursively through nested objects, arrays, and union variants.
 *
 * Only structure is compared. Representation differences between the two generators
 * (pattern vs format, const vs single-value enum, `type: [x, 'null']` vs anyOf-with-null,
 * oneOf vs anyOf, descriptions/examples) are deliberately ignored.
 */

type Json = Record<string, unknown>;
type Shape =
  | 'leaf'
  | { object: Record<string, Shape>; required: string[] }
  | { array: Shape }
  | { union: Shape[] };

const REREGISTERED = ['ProfileSummary', 'Role', 'RoomIcon', 'Channel', 'Room', 'Member'] as const;

function isNullOnly(schema: Json): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.every((t) => t === 'null'));
}

/** Structural signature of a JSON Schema, resolving `$ref`s with `resolve`. */
function shapeOf(schema: Json, resolve: (ref: string) => Json, depth = 0): Shape {
  if (depth > 20) throw new Error('schema nesting too deep (cyclic $ref?)');
  const next = (s: unknown) => shapeOf(s as Json, resolve, depth + 1);

  if (typeof schema.$ref === 'string') return next(resolve(schema.$ref));

  const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (variants) {
    const shapes = variants.filter((v) => !isNullOnly(v)).map(next);
    // A nullable wrapper (x | null) is just x; a real union is compared order-independently.
    if (shapes.length === 1) return shapes[0] as Shape;
    return { union: shapes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  }
  if (Array.isArray(schema.allOf)) {
    // Merge object parts (zod-to-openapi uses allOf for extended registered objects).
    const object: Record<string, Shape> = {};
    const required: string[] = [];
    for (const part of schema.allOf.map(next)) {
      if (part === 'leaf') continue;
      if (!('object' in part)) return part;
      Object.assign(object, part.object);
      required.push(...part.required);
    }
    return { object, required: [...new Set(required)].sort() };
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const object = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Json>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, next(value)]),
    );
    return { object, required: [...((schema.required as string[] | undefined) ?? [])].sort() };
  }
  if (schema.items) return { array: next(schema.items) };
  return 'leaf';
}

const openapi = buildOpenApiContract() as { components: { schemas: Record<string, Json> } };
const components = openapi.components.schemas;

function resolveOpenApi(ref: string): Json {
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  const target = name ? components[name] : undefined;
  if (!target) throw new Error(`unresolvable $ref ${ref}`);
  return target;
}

function resolveNone(ref: string): Json {
  throw new Error(`unexpected $ref ${ref} in a self-contained JSON Schema`);
}

describe('REST components re-registered from events.ts match their originals', () => {
  it.each(REREGISTERED)('%s has the same property keys and required lists', (name) => {
    const rest = components[name];
    expect(rest, `components.schemas.${name} is missing from openapi.json`).toBeDefined();
    // reused: 'inline' keeps the original self-contained (no $defs/$ref to resolve).
    const original = z.toJSONSchema(sharedSchemas[name], { reused: 'inline' }) as Json;

    const restShape = shapeOf(rest as Json, resolveOpenApi);
    expect(restShape).toStrictEqual(shapeOf(original, resolveNone));
    // Guard against a vacuous pass: every object-valued shared shape has properties.
    if (name !== 'Role') expect(restShape).not.toBe('leaf');
  });

  it('detects drift (self-check): an extra field or a changed required list is not equal', () => {
    const base = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const shape = (schema: z.ZodType) => shapeOf(z.toJSONSchema(schema), resolveNone);
    expect(shape(base)).not.toStrictEqual(shape(base.extend({ d: z.string() })));
    expect(shape(base)).not.toStrictEqual(shape(base.partial({ a: true })));
    expect(shape(base)).not.toStrictEqual(shape(z.object({ a: z.string(), b: z.object({ c: z.number(), e: z.null() }) })));
    // Representation-only differences are equal.
    expect(shape(z.object({ a: z.string().nullable() }))).toStrictEqual(shape(z.object({ a: z.string() })));
  });
});
