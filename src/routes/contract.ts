import { fileURLToPath } from 'node:url';
import { NotFoundError } from '../errors.js';
import { documentedRouter, type DocumentedRouter } from './documentedRouter.js';

// Resolves to <repo>/contract from both src/routes and dist/routes.
const defaultContractDir = fileURLToPath(new URL('../../contract/', import.meta.url));

export function createContractRouter(contractDir = defaultContractDir): DocumentedRouter {
  const router = documentedRouter('/api/contract');
  for (const file of ['openapi.json', 'events.schema.json']) {
    router.get(`/${file}`, (_req, res, next) => {
      res.sendFile(file, { root: contractDir, maxAge: '5m' }, (err) => {
        if (!err) return;
        next((err as { status?: number }).status === 404 ? new NotFoundError('Contract not generated.') : err);
      });
    });
  }
  return router;
}
