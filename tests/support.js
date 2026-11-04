import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.js';
import { createGateway } from '../server/gateway.js';

export const supabaseUrl = process.env.TEST_SUPABASE_URL;
export const supabaseKey = process.env.TEST_SUPABASE_KEY;

export function freshClient() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Set TEST_SUPABASE_URL and TEST_SUPABASE_KEY in .env.test or the shell.');
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function must({ data, error }) {
  assert.ifError(error);
  return data;
}

export async function account() {
  const client = freshClient();
  const email = 'diner-' + randomUUID() + '@example.com';
  const password = 'Dinner!' + randomUUID();
  const { user, session } = must(await client.auth.signUp({
    email, password, options: { data: { display_name: 'Test diner' } },
  }));
  assert.ok(session, 'The disposable test project must have email confirmation disabled.');
  return { client, user, token: session.access_token, email, password };
}

export async function asExistingUser(identity) {
  const client = freshClient();
  must(await client.auth.setSession({
    access_token: identity.session.access_token,
    refresh_token: identity.session.refresh_token,
  }));
  return client;
}

export async function startApi(clientDist) {
  const gateway = createGateway(supabaseUrl, supabaseKey);
  const app = createApp({ gateway, supabaseUrl, clientDist });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
    async call(actor, path, body) {
      const response = await fetch(origin + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(actor && { Authorization: 'Bearer ' + actor.token }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, ...await response.json() };
    },
  };
}

export async function subscribed(channel, timeout = 12_000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Realtime subscription timed out.')), timeout);
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer);
        reject(error ?? new Error('Realtime subscription ' + status));
      }
    });
  });
}

export function pollChanges(client, poll, callback) {
  return client.channel('poll:' + poll)
    .on('postgres_changes', {
      schema: 'public', table: 'polls', event: 'UPDATE', filter: 'id=eq.' + poll,
    }, callback);
}

export async function createGroup(owner, members) {
  const group = must(await owner.client.rpc('create_dining_group', { p_name: 'Dinner club' }));
  const invite = must(await owner.client.rpc('dining_group_invite', { p_group: group }));
  for (const member of members) {
    assert.equal(must(await member.client.rpc('join_dining_group', { p_invite: invite })), group);
  }
  return group;
}

export async function setupPoll(owner, group, question = 'Dinner tonight?') {
  const poll = must(await owner.client.rpc('create_dining_poll', { p_group: group, p_question: question }));
  const add = (name) => owner.client.rpc('suggest_restaurant', {
    p_poll: poll, p_name: name, p_category: 'Bistro', p_price: 2,
  });
  const first = must(await add('First suggestion'));
  const second = must(await add('Second suggestion'));
  return { poll, first, second };
}

export function readPoll(actor, poll) {
  return actor.client.rpc('dining_poll_snapshot', { p_poll: poll }).then(must);
}
