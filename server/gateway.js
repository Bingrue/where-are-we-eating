import { createClient } from '@supabase/supabase-js';

export function createGateway(url, key) {
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  const authClient = createClient(url, key, options);

  return {
    async authenticate(token) {
      const { data, error } = await authClient.auth.getUser(token);
      if (error && (!error.status || error.status >= 500)) {
        throw new Error('Supabase Auth is unavailable.', { cause: error });
      }
      return Boolean(!error && data.user);
    },
    async run(token, name, args) {
      const client = createClient(url, key, {
        ...options,
        global: { headers: { Authorization: 'Bearer ' + token } },
      });
      return client.rpc(name, args);
    },
  };
}
