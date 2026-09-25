import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/*
 * Generates the ES256 (P-256) private JWK that signs Realtime tokens (SUPABASE_JWT_PRIVATE_JWK).
 * Import the same JWK in Dashboard -> Project Settings -> JWT Keys as a standby key, then
 * rotate it to current. Only the JWK is printed to stdout. Refuses to run without a TTY on
 * both stdin and stdout, so the key is never captured by an agent, a pipe, or a log.
 * https://supabase.com/docs/guides/auth/signing-keys
 */

export interface JwtSigningJwk extends JsonWebKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export function generateJwtSigningKey(): JwtSigningJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const { x, y, d } = jwk;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !x || !y || !d) {
    throw new Error('unexpected JWK export from node:crypto');
  }
  return { kty: 'EC', crv: 'P-256', x, y, d, kid: randomUUID(), alg: 'ES256', use: 'sig' };
}

/**
 * Humans only (like db:reset): the output is a private signing key, so it must land on a
 * person's terminal, never in an agent transcript, CI log, or pipe. Agents have no TTY.
 */
export function refuseWithoutTty(stdinIsTty: boolean | undefined, stdoutIsTty: boolean | undefined): string | null {
  if (stdinIsTty && stdoutIsTty) return null;
  return (
    'jwt:keygen must be run by a person in an interactive terminal: it prints a private signing key. ' +
    'Agents and scripts never run it.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refusal = refuseWithoutTty(process.stdin.isTTY, process.stdout.isTTY);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(generateJwtSigningKey())}\n`);
  process.stderr.write(
    'Put this line in .env as SUPABASE_JWT_PRIVATE_JWK and import the same JWK in the Supabase dashboard ' +
      '(Project Settings -> JWT Keys) as a standby key, then rotate it to current.\n' +
      'It is a private signing key: never commit or share it.\n',
  );
}
