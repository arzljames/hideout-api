import { TEST_JWT_PRIVATE_JWK } from './helpers/jwtKey.js';

// Deterministic, fake configuration so src/config/env.ts validates in tests.

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_URL: 'http://localhost:5173',
  WEB_ORIGIN: 'http://localhost:5173',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_JWT_PRIVATE_JWK: TEST_JWT_PRIVATE_JWK,
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  STEAM_API_KEY: 'test-steam-api-key',
  LIVEKIT_URL: 'ws://localhost:7880',
  LIVEKIT_API_KEY: 'test-livekit-key',
  LIVEKIT_API_SECRET: 'test-livekit-secret',
});
