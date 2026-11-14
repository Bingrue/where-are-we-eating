import express from 'express';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const clientDist = fileURLToPath(new URL('../client/dist/', import.meta.url));
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

app.get('/api/health', async (_req, res) => {
  let supabaseStatus = 'not_configured';

  if (supabaseUrl && supabaseKey && !supabaseKey.startsWith('replace-with-')) {
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

app.use(express.static(clientDist));

app.listen(port, () => {
  console.log(`Express listening on port ${port}`);
});
