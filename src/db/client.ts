import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * Service-role client. Bypasses RLS, so every room-scoped caller must check
 * membership and role in code first. Never expose this client or its key.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
