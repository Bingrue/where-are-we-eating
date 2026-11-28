import { supabase } from './supabase.js';

function request(path, method, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Call the Express API as the signed-in user. The access token comes from
// supabase.auth.getSession(), which returns a refreshed token when the old one is
// about to expire, and is sent as `Authorization: Bearer <token>` for Express to verify.
//
// A 401 does not sign the user out by itself: the API can reject a token for reasons
// that have nothing to do with the session (a cold start that could not reach Supabase,
// a server misconfiguration, a token that expired a moment ago). Instead we refresh the
// session and retry once. Only if Supabase itself says the refresh token is no longer
// valid does supabase-js end the session, and the app shows the sign-in screen.
export async function api(path, { method = 'GET', body } = {}) {
  const { data } = await supabase.auth.getSession();
  let response = await request(path, method, body, data.session?.access_token);

  if (response.status === 401 && data.session) {
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (!error && refreshed.session) {
      response = await request(path, method, body, refreshed.session.access_token);
    }
  }

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
