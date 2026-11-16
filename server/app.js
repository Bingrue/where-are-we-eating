import express from 'express';
import { fileURLToPath } from 'node:url';
import { requireAuth } from './auth.js';
import { groupsRouter } from './routes/groups.js';
import { meRouter } from './routes/me.js';
import { isSupabaseConfigured, supabaseKey, supabaseUrl } from './supabase.js';

const clientDist = fileURLToPath(new URL('../client/dist/', import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', async (_req, res) => {
    let supabaseStatus = 'not_configured';

    if (isSupabaseConfigured()) {
      try {
        const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/health`, {
          headers: { apikey: supabaseKey },
          signal: AbortSignal.timeout(5000),
        });
        supabaseStatus = response.ok ? 'connected' : 'unavailable';
      } catch {
        supabaseStatus = 'unavailable';
      }
    }

    res.status(200).json({ status: 'ok', supabase: supabaseStatus });
  });

  // Everything below needs a signed-in user.
  app.use('/api', requireAuth);
  app.use('/api/me', meRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Production: serve the built React app, including client-side routes like /join/<code>.
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res, next) => {
    res.sendFile('index.html', { root: clientDist }, (error) => error && next());
  });

  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  });

  return app;
}
