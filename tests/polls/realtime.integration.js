// Real Supabase transport, limited to task 6. No task 5 function substitutes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createPollRepository } from '../../client/src/polls/repository.js';

test('a second authenticated user receives a suggestion through Postgres Changes and reads its snapshot', { timeout: 60000 }, async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY, secret = process.env.SUPABASE_SECRET_KEY;
  assert.ok(url && key && secret, 'Set local Supabase credentials before running test:realtime.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), 'Use local Supabase only.');
  const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const admin = createClient(url, secret, { auth });
  const users = [];
  let groupId, stop = () => {};
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  try {
    for (let i = 0; i < 2; i++) {
      const email = `realtime-${randomUUID()}@example.com`, password = `Test!${randomUUID()}`;
      const user = must(await admin.auth.admin.createUser({ email, password, email_confirm: true })).user;
      users.push({ id: user.id });
      const client = createClient(url, key, { auth });
      Object.assign(users.at(-1), { client, repository: createPollRepository(client) });
      must(await client.auth.signInWithPassword({ email, password }));
    }
    const [host, guest] = users;
    const group = must(await host.client.from('groups').insert({ name: 'Task 6 integration' }).select('id, invite_code').single());
    groupId = group.id;
    must(await guest.client.rpc('join_group', { p_invite_code: group.invite_code }));
    const poll = await host.repository.create(groupId, 'Live suggestions?');
    let resolveChange, rejectChange, timeout;
    const changed = new Promise((resolve, reject) => { resolveChange = resolve; rejectChange = reject; });
    // Attach a handler immediately, so a readiness failure cannot leave a rejection unhandled.
    void changed.catch(() => {});
    try {
      await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Postgres Changes subscription did not become ready.')), 20000);
        stop = guest.repository.observe(poll.id, async () => {
          try {
            const snapshot = await guest.repository.read(poll.id, guest.id);
            if (snapshot.options.some((option) => option.restaurant_name === 'Live Ramen')) resolveChange(snapshot);
          } catch (error) { rejectChange(error); }
        }, (status) => { if (status === 'live') resolve(); });
      });
      clearTimeout(timeout);
      timeout = setTimeout(() => rejectChange(new Error('Suggestion was not delivered by Realtime.')), 20000);
      await host.repository.suggest(poll.id, { restaurant_name: 'Live Ramen' });
      const snapshot = await changed;
      assert.equal(snapshot.options[0].vote_count, 0);
      assert.equal(snapshot.my_option_id, null);
    } finally { clearTimeout(timeout); }
  } finally {
    stop();
    if (groupId) must(await admin.from('groups').delete().eq('id', groupId));
    for (const user of users) {
      await user.client?.removeAllChannels();
      must(await admin.auth.admin.deleteUser(user.id));
    }
  }
});
