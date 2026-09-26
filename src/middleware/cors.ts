import cors from 'cors';
import { env } from '../config/env.js';

export const corsMiddleware = cors({
  origin: env.WEB_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  // Web and API are different origins in production (same site), so custom response headers must be exposed.
  exposedHeaders: ['Idempotent-Replayed'],
  maxAge: 600,
});
