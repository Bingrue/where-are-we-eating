import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseKey && !supabaseKey.startsWith('replace-with-'));
}

// Express never stores a session of its own; each request carries the user's token.
const serverAuthOptions = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

let authClient;

// Client used only to verify access tokens with supabase.auth.getClaims().
export function getAuthClient() {
  authClient ??= createClient(supabaseUrl, supabaseKey, { auth: serverAuthOptions });
  return authClient;
}

// Client that acts as the signed-in user: Supabase sees their token on every query,
// so auth.uid() is their id and row level security applies to everything it does.
export function createUserClient(accessToken) {
  return createClient(supabaseUrl, supabaseKey, {
    auth: serverAuthOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
