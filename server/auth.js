import { createUserClient, getAuthClient, isSupabaseConfigured } from './supabase.js';

// Express middleware: require a valid Supabase access token.
//
// The browser sends `Authorization: Bearer <access token>`. supabase.auth.getClaims()
// checks the token's signature and expiry: with asymmetric signing keys it verifies
// locally against the project's published keys (JWKS); with a legacy shared secret it
// asks Supabase Auth. On success the request gets:
//   req.user      { id, email, claims }
//   req.supabase  a Supabase client that runs as this user, so RLS applies
export async function requireAuth(req, res, next) {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({ error: 'Supabase is not configured on the server.' });
  }

  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  if (!match) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }

  const token = match[1];
  let result;
  try {
    result = await getAuthClient().auth.getClaims(token);
  } catch {
    return res.status(401).json({ error: 'Your session is not valid. Sign in again.' });
  }

  const claims = result?.data?.claims;
  if (result?.error || !claims?.sub || claims.role !== 'authenticated') {
    return res.status(401).json({ error: 'Your session is not valid. Sign in again.' });
  }

  req.user = { id: claims.sub, email: claims.email, claims };
  req.supabase = createUserClient(token);
  return next();
}
