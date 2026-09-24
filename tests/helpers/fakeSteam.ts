import { vi } from 'vitest';

/*
 * Offline Steam at the fetch boundary: OpenID check_authentication and
 * ISteamUser/GetPlayerSummaries. Install with `vi.stubGlobal('fetch', steamFetch)`.
 */

export const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';
export const SUMMARIES_PREFIX = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
export const STEAM_ID = '76561197960287930';
export const AVATAR = 'https://avatars.steamstatic.com/abc_full.jpg';

type Handler = (init: RequestInit | undefined) => Promise<Response>;

export const steam: { checkAuth: Handler; summaries: Handler } = {
  checkAuth: () => Promise.resolve(validCheck()),
  summaries: () => Promise.resolve(summariesResponse()),
};

export function validCheck(): Response {
  return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 });
}

export function summariesResponse(
  players: Record<string, unknown>[] = [{ steamid: STEAM_ID, personaname: '  Gordon  ', avatarfull: AVATAR }],
): Response {
  return Response.json({ response: { players } });
}

export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export const steamFetch = vi.fn<typeof fetch>((input, init) => {
  const url = urlOf(input);
  if (url === STEAM_OP_ENDPOINT) return steam.checkAuth(init);
  if (url.startsWith(SUMMARIES_PREFIX)) return steam.summaries(init);
  return Promise.reject(new Error('unexpected fetch in test'));
});

export function resetFakeSteam(): void {
  steam.checkAuth = () => Promise.resolve(validCheck());
  steam.summaries = () => Promise.resolve(summariesResponse());
  steamFetch.mockClear();
}

export function fetchCallsTo(prefix: string): [string, RequestInit | undefined][] {
  return steamFetch.mock.calls
    .map(([input, init]): [string, RequestInit | undefined] => [urlOf(input), init])
    .filter(([url]) => url.startsWith(prefix));
}

/** A positive assertion as Steam would send it to the callback. */
export function assertionParams(returnTo: string, steamId = STEAM_ID): Record<string, string> {
  const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OP_ENDPOINT,
    'openid.claimed_id': claimed,
    'openid.identity': claimed,
    'openid.return_to': returnTo,
    'openid.response_nonce': '2026-09-25T10:00:00ZnonceNONCE',
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'SIGNATURE-VALUE-abc123=',
  };
}
