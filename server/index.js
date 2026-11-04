import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createGateway } from './gateway.js';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PORT = '3000', TRUST_PROXY_HOPS = '0' } = process.env;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in server/.env.');
}
const trustProxy = Number(TRUST_PROXY_HOPS);
if (!/^\d+$/.test(TRUST_PROXY_HOPS) || !Number.isSafeInteger(trustProxy)) {
  throw new Error('TRUST_PROXY_HOPS must be a nonnegative integer.');
}
const dist = fileURLToPath(new URL('../client/dist/', import.meta.url));
const app = createApp({
  gateway: createGateway(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY),
  supabaseUrl: SUPABASE_URL,
  clientDist: existsSync(dist + 'index.html') ? dist : undefined,
  trustProxy,
});
app.listen(Number(PORT), () => console.log('Dining poll server listening on port ' + PORT));
