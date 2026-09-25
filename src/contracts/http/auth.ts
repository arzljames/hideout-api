import { z } from 'zod';
import { authedErrors, errorResponse } from './common.js';
import { registry } from './registry.js';

/** Codes the Steam callback appends as `?auth_error=<code>` when it redirects back to WEB_ORIGIN. */
export const authRedirectErrorCodes = [
  'STEAM_LOGIN_FAILED',
  'LOGIN_STATE_MISMATCH',
  'STEAM_UNAVAILABLE',
  'LOGIN_FAILED',
  'RATE_LIMITED',
] as const;
export type AuthRedirectErrorCode = (typeof authRedirectErrorCodes)[number];

/** Registered as a component so hideout-web gets a typed union for `?auth_error=`. */
export const AuthRedirectError = registry.register(
  'AuthRedirectError',
  z.enum(authRedirectErrorCodes).openapi({
    description:
      'Value of the `auth_error` query param when the Steam callback redirects back to WEB_ORIGIN. ' +
      'STEAM_LOGIN_FAILED: Steam rejected or we could not verify the sign-in. LOGIN_STATE_MISMATCH: the ' +
      'sign-in was not started from this browser (or took over 10 minutes). STEAM_UNAVAILABLE: Steam ' +
      'could not be reached. LOGIN_FAILED: our server failed to create the session. RATE_LIMITED: too ' +
      'many sign-in attempts from this network; try again in a minute.',
  }),
);

const redirect = (description: string, setCookie: string) => ({
  description,
  headers: z.object({
    Location: z.string().openapi({ description: 'Redirect target.' }),
    'Set-Cookie': z.string().openapi({ description: setCookie }),
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/auth/steam',
  tags: ['auth'],
  security: [],
  summary: 'Start Steam sign-in',
  description:
    'Navigate the browser here (a full page load, not fetch). Sets a short-lived state cookie and ' +
    'redirects to Steam. Steam then sends the browser to /api/auth/steam/callback.',
  responses: {
    302: redirect(
      'Redirect to the Steam sign-in page, or to WEB_ORIGIN/?auth_error=RATE_LIMITED when rate limited.',
      'httpOnly login state cookie (10 minutes).',
    ),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/auth/steam/callback',
  tags: ['auth'],
  security: [],
  summary: 'Steam sign-in callback',
  description:
    'Steam redirects the browser here; clients never call it directly. On success it sets the session ' +
    'cookie and redirects to WEB_ORIGIN/. On failure it redirects to ' +
    'WEB_ORIGIN/?auth_error=<code>; see the AuthRedirectError schema for the codes.',
  responses: {
    302: redirect(
      'Redirect back to hideout-web: WEB_ORIGIN/ on success, WEB_ORIGIN/?auth_error=<AuthRedirectError> on failure.',
      'Clears the login state cookie; on success also sets the httpOnly session cookie (7 days).',
    ),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/logout',
  tags: ['auth'],
  summary: 'Sign out of this device',
  description:
    'Deletes the current session and clears the cookie. Send `Content-Type: application/json` ' +
    '(no body needed) with credentials; the CSRF check requires it.',
  responses: {
    204: { description: 'Signed out.' },
    ...authedErrors,
    403: errorResponse('Origin or Content-Type check failed.'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/logout-all',
  tags: ['auth'],
  summary: 'Sign out of every device',
  description: 'Deletes all of the current user’s sessions and clears the cookie. Same request rules as logout.',
  responses: {
    204: { description: 'Signed out everywhere.' },
    ...authedErrors,
    403: errorResponse('Origin or Content-Type check failed.'),
  },
});

/** The signed-in user's own profile. A plain object so fields can be added without breaking clients. */
export const Me = registry.register(
  'Me',
  z.object({
    id: z.guid(),
    steamId: z.string().regex(/^[0-9]{17}$/).openapi({ example: '76561197960287930' }),
    displayName: z.string().min(1).max(64).openapi({ example: 'Gordon' }),
    avatarUrl: z.url({ protocol: /^https$/ }).nullable(),
  }),
);
export type Me = z.infer<typeof Me>;

registry.registerPath({
  method: 'get',
  path: '/api/auth/me',
  tags: ['auth'],
  summary: 'Current user',
  description:
    'The signed-in user’s own profile. Call on load with credentials: 200 means signed in, 401 means signed out. ' +
    'Sent with `Cache-Control: no-store`.',
  responses: {
    200: { description: 'The signed-in user.', content: { 'application/json': { schema: Me } } },
    ...authedErrors,
    500: errorResponse('Unexpected server error.'),
  },
});
