import { Router } from 'express';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/*
 * Swagger UI for contract/openapi.json, served same-origin from swagger-ui-dist so it
 * fits helmet's default CSP (no CDN, no inline scripts). Public, like the contract itself.
 * "Try it out" sends the session cookie. On the API origin, state-changing requests are
 * rejected by requireSameOrigin (Origin must be WEB_ORIGIN); through the Vite proxy they pass.
 */

const swaggerDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
const ASSETS = ['swagger-ui.css', 'swagger-ui-bundle.js', 'favicon-32x32.png'] as const;

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>hideout-api docs</title>
  <link rel="icon" href="/api/docs/assets/favicon-32x32.png">
  <link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/api/docs/init.js"></script>
</body>
</html>
`;

// BaseLayout (no URL bar) and no query config, so the page only ever renders our contract.
const init = `window.ui = SwaggerUIBundle({
  url: '/api/contract/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  layout: 'BaseLayout',
  validatorUrl: null,
  withCredentials: true,
});
`;

export const docsRouter = Router();

docsRouter.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(page);
});

docsRouter.get('/init.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('js').send(init);
});

for (const file of ASSETS) {
  docsRouter.get(`/assets/${file}`, (_req, res, next) => {
    res.sendFile(file, { root: swaggerDir, maxAge: '1d' }, (err) => {
      if (err) next(err);
    });
  });
}
