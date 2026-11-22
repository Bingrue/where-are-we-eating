import { supabase } from './supabase.js';

// Call the Express API as the signed-in user. The access token comes from
// supabase.auth.getSession(), which returns a refreshed token when the old one is
// about to expire, and is sent as `Authorization: Bearer <token>` for Express to verify.
export async function api(path, { method = 'GET', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    // The token was rejected (for example, the user was deleted): drop the local session.
    await supabase.auth.signOut({ scope: 'local' });
  }
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
