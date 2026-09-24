import cors from 'cors';
import { env } from '../config/env.js';

export const corsMiddleware = cors({
  origin: env.WEB_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  maxAge: 600,
});
