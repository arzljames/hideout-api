import { z } from 'zod';
import { errorCodes } from '../../errors.js';
import { registry } from './registry.js';

export const ErrorResponse = registry.register(
  'ErrorResponse',
  z.object({
    error: z.object({
      // A string, not an enum, so adding codes stays non-breaking. Known codes are listed in the description.
      code: z.string().openapi({ example: 'VALIDATION_FAILED', description: `One of: ${errorCodes.join(', ')}.` }),
      message: z.string().openapi({ example: 'This invite has expired.' }),
      details: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional()
        .openapi({ description: 'Present on 422 validation errors.' }),
    }),
  }),
);

export const Id = z.guid();

export const CursorQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function page<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ErrorResponse } } };
}

/** Standard error responses for authenticated routes. */
export const authedErrors = {
  401: errorResponse('Not signed in.'),
  429: errorResponse('Rate limited.'),
} as const;
