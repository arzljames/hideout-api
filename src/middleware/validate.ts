import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { ValidationError, type FieldIssue } from '../errors.js';

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

function toIssues(location: string, error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: [location, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/** Validates and replaces req.body / req.query / req.params with the parsed values. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: FieldIssue[] = [];
    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (!result.success) {
        issues.push(...toIssues(location, result.error));
        continue;
      }
      // Express 5 exposes req.query as a getter, so define the parsed value on the instance.
      Object.defineProperty(req, location, { value: result.data, writable: true, configurable: true });
    }
    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }
    next();
  };
}
