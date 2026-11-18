import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && key && !key.startsWith('replace-with-'));

// One client for the whole app. Supabase Auth keeps the session in localStorage,
// refreshes the access token before it expires, and reads the session from
// email links (sign-up confirmation, password reset) when the page loads.
export const supabase = isSupabaseConfigured
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
