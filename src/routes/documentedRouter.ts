import { Router, type RequestHandler } from 'express';
import { registry } from '../contracts/http/index.js';

const API_PREFIX = '/api';

/*
 * The only way to add routes under src/routes (plain `Router` is lint-banned there).
 * Every route must already be registered with `registry.registerPath` in
 * src/contracts/http, so it appears in contract/openapi.json and Swagger UI at
 * /api/docs. Otherwise building the app throws, which fails every test.
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface DocumentedRouter {
  readonly router: Router;
  /** Full path including /api; mount() uses it, so documented and real paths can't drift. */
  readonly mountPath: string;
  get(path: string, ...handlers: RequestHandler[]): DocumentedRouter;
  post(path: string, ...handlers: RequestHandler[]): DocumentedRouter;
  put(path: string, ...handlers: RequestHandler[]): DocumentedRouter;
  patch(path: string, ...handlers: RequestHandler[]): DocumentedRouter;
  delete(path: string, ...handlers: RequestHandler[]): DocumentedRouter;
  /** Escape hatch for routes that aren't part of the API (e.g. Swagger UI's own assets). */
  undocumented(reason: string, define: (router: Router) => void): DocumentedRouter;
}

function documentedRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const def of registry.definitions) {
    if (def.type === 'route') routes.add(`${def.route.method} ${def.route.path}`);
  }
  return routes;
}

/** Express path under a mount point, as OpenAPI writes it (`:id` → `{id}`). */
export function openApiPath(mountPath: string, path: string): string {
  const full = `${mountPath}${path === '/' ? '' : path}`.replace(/:(\w+)/g, '{$1}');
  return full || '/';
}

/** @param mountPath where apiRouter mounts this router, including `/api` (e.g. `/api/auth`). */
export function documentedRouter(mountPath: string): DocumentedRouter {
  if (mountPath !== API_PREFIX && !mountPath.startsWith(`${API_PREFIX}/`)) {
    throw new Error(`documentedRouter mount path must be under ${API_PREFIX}: ${mountPath}`);
  }
  const router = Router();

  const add =
    (method: Method) =>
    (path: string, ...handlers: RequestHandler[]): DocumentedRouter => {
      const full = openApiPath(mountPath, path);
      if (!documentedRoutes().has(`${method} ${full}`)) {
        throw new Error(
          `${method.toUpperCase()} ${full} is not documented. Register it with registry.registerPath ` +
            'in src/contracts/http so it appears in /api/docs.',
        );
      }
      router[method](path, ...handlers);
      return api;
    };

  const api: DocumentedRouter = {
    router,
    mountPath,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
    undocumented(reason, define) {
      if (!reason.trim()) throw new Error('undocumented routes need a reason');
      define(router);
      return api;
    },
  };
  return api;
}

/** Mounts a documented router on the router serving /api, at the path it was documented under. */
export function mount(apiRouter: Router, documented: DocumentedRouter): void {
  apiRouter.use(documented.mountPath.slice(API_PREFIX.length) || '/', documented.router);
}
