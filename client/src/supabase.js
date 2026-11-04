import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && key ? createClient(url, key) : null;

export async function command(path, body, method = 'POST') {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error('Sign in to continue.');
  const response = await fetch('/api' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + data.session.access_token,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    throw new Error(result?.error ?? 'Could not reach the dining poll server.');
  }
  return result.data;
}

export function unwrap({ data, error }) {
  if (error) {
    if (error.code?.startsWith('PT')) throw new Error(error.message);
    throw new Error('Could not load your data. Please try again.');
  }
  return data;
}
