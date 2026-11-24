// "Attack" tests: call the Supabase Data API directly (not through Express) as different
// users and prove that row level security and table grants block every attempt to read
// or change another group's data. They also cover the voting functions (ties, closing
// with no votes, a vote racing a close) and Express's token checks.
//
// Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY in .env.test.
// The secret key is used only to create and delete the test users and their groups;
// every attack runs with the publishable key and a user token.
//
//   npm run test:rls
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(url && publishableKey && secretKey);

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const run = randomUUID().slice(0, 8);
const password = `Test-${randomUUID()}`;

const admin = configured ? createClient(url, secretKey, noSession) : null;
const users = {};
const createdGroups = [];
let groupId;
let inviteCode;
let pollId;
let optionId;
let secondOptionId;
let strangerGroupId;

async function createUser(name) {
  const email = `rls-${name}-${run}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username: `${name}_${run}`, display_name: name },
  });
  assert.ifError(error);

  const client = createClient(url, publishableKey, noSession);
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { id: data.user.id, client, token: signIn.session.access_token };
}

// A request was blocked either by a missing grant / RLS check (error 42501)
// or because RLS hid every row, so nothing came back or changed.
function assertBlocked({ data, error }) {
  if (error) {
    assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
  } else {
    assert.deepEqual(data, [], 'expected no rows to be returned or changed');
  }
}

function assertRlsViolation({ error }) {
  assert.ok(error, 'expected the request to fail');
  assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
}

describe('row level security attacks', { skip: !configured && 'set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY in .env.test' }, () => {
  before(async () => {
    users.alice = await createUser('alice');
    users.bob = await createUser('bob');
    users.mallory = await createUser('mallory');

    // Alice creates a group, Bob joins it with the invite code.
    const group = await users.alice.client.from('groups').insert({ name: `Alice's group ${run}` })
      .select('id, invite_code').single();
    assert.ifError(group.error);
    groupId = group.data.id;
    inviteCode = group.data.invite_code;
    createdGroups.push(groupId);

    const joined = await users.bob.client.rpc('join_group', { p_invite_code: inviteCode });
    assert.ifError(joined.error);

    const poll = await users.alice.client.from('polls').insert({ group_id: groupId, question: 'Where tonight?' })
      .select('id').single();
    assert.ifError(poll.error);
    pollId = poll.data.id;

    const option = await users.alice.client.from('options')
      .insert({ poll_id: pollId, restaurant_name: 'Taco Place', price_range: '$', food_category: 'Mexican' })
      .select('id').single();
    assert.ifError(option.error);
    optionId = option.data.id;

    const secondOption = await users.alice.client.from('options')
      .insert({ poll_id: pollId, restaurant_name: 'Noodle House' }).select('id').single();
    assert.ifError(secondOption.error);
    secondOptionId = secondOption.data.id;

    const vote = await users.alice.client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: optionId });
    assert.ifError(vote.error);

    // Mallory has a group of her own, so she is a normal signed-in user.
    const own = await users.mallory.client.from('groups').insert({ name: `Mallory's group ${run}` })
      .select('id').single();
    assert.ifError(own.error);
    strangerGroupId = own.data.id;
    createdGroups.push(strangerGroupId);
  });

  after(async () => {
    if (!admin) return;
    // groups.created_by and polls.created_by are ON DELETE RESTRICT: remove groups first.
    if (createdGroups.length) await admin.from('groups').delete().in('id', createdGroups);
    for (const user of Object.values(users)) await admin.auth.admin.deleteUser(user.id);
  });

  describe('members get what they should', () => {
    test('the creator is the admin and the invited user is a member', async () => {
      const { data, error } = await users.alice.client.from('group_members').select('user_id, role')
        .eq('group_id', groupId).order('role');
      assert.ifError(error);
      assert.deepEqual(data.map((row) => row.role), ['admin', 'member']);
    });

    test('a member can read the poll, options, votes and other members\' profiles', async () => {
      const { client } = users.bob;
      assert.equal((await client.from('polls').select('id').eq('id', pollId)).data.length, 1);
      assert.equal((await client.from('options').select('id').eq('poll_id', pollId)).data.length, 2);
      assert.equal((await client.from('votes').select('id').eq('poll_id', pollId)).data.length, 1);
      assert.equal((await client.from('profiles').select('id').eq('id', users.alice.id)).data.length, 1);
    });

    test('a member can vote and change their own vote through the locking RPC', async () => {
      const { client } = users.bob;
      assert.ifError((await client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: secondOptionId })).error);
      assert.ifError((await client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: optionId })).error);
      assert.ifError((await client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: secondOptionId })).error);
      const totals = await client.rpc('get_vote_totals', { p_poll_id: pollId });
      assert.ifError(totals.error);
      assert.deepEqual(totals.data.map((row) => Number(row.vote_count)), [1, 1]);
    });
  });

  describe('signed-out requests (publishable key only)', () => {
    const anon = configured ? createClient(url, publishableKey, noSession) : null;

    for (const table of ['profiles', 'groups', 'group_members', 'polls', 'options', 'votes']) {
      test(`cannot read ${table}`, async () => {
        assertBlocked(await anon.from(table).select('*'));
      });
    }

    test('cannot join a group, even with a valid invite code', async () => {
      const { error } = await anon.rpc('join_group', { p_invite_code: inviteCode });
      assert.ok(error);
    });
  });

  describe('an outsider (Mallory) cannot read another group', () => {
    test('groups: sees only her own group', async () => {
      const { data, error } = await users.mallory.client.from('groups').select('id');
      assert.ifError(error);
      assert.deepEqual(data.map((row) => row.id), [strangerGroupId]);
    });

    test('groups: asking for the id directly returns nothing', async () => {
      assertBlocked(await users.mallory.client.from('groups').select('*').eq('id', groupId));
    });

    test('group_members, polls, options and votes return nothing', async () => {
      const { client } = users.mallory;
      assertBlocked(await client.from('group_members').select('*').eq('group_id', groupId));
      assertBlocked(await client.from('polls').select('*').eq('group_id', groupId));
      assertBlocked(await client.from('options').select('*').eq('poll_id', pollId));
      assertBlocked(await client.from('votes').select('*').eq('poll_id', pollId));
    });

    test('profiles: cannot see users she shares no group with', async () => {
      assertBlocked(await users.mallory.client.from('profiles').select('*')
        .in('id', [users.alice.id, users.bob.id]));
    });

    test('embedding through her own rows does not leak other groups', async () => {
      const { data, error } = await users.mallory.client.from('group_members')
        .select('group_id, groups(name, polls(question))');
      assert.ifError(error);
      assert.ok(data.every((row) => row.group_id === strangerGroupId));
    });
  });

  describe('an outsider (Mallory) cannot change another group', () => {
    test('cannot add herself to the group without the invite code', async () => {
      assertRlsViolation(await users.mallory.client.from('group_members')
        .insert({ group_id: groupId, user_id: users.mallory.id, role: 'admin' }));
    });

    test('cannot join with a guessed invite code', async () => {
      const { error } = await users.mallory.client.rpc('join_group', { p_invite_code: '0'.repeat(32) });
      assert.equal(error?.code, 'P0002');
    });

    test('cannot create a poll, suggest an option or vote', async () => {
      const { client } = users.mallory;
      assertRlsViolation(await client.from('polls').insert({ group_id: groupId, question: 'Hijacked?' }));
      assertRlsViolation(await client.from('options').insert({ poll_id: pollId, restaurant_name: 'Spam Diner' }));
      assertRlsViolation(await client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: optionId }));
      assertRlsViolation(await client.from('votes').insert({ poll_id: pollId, option_id: optionId }));
    });

    test('cannot rename or delete the group', async () => {
      const { client } = users.mallory;
      assertBlocked(await client.from('groups').update({ name: 'pwned' }).eq('id', groupId).select());
      assertBlocked(await client.from('groups').delete().eq('id', groupId).select());
      const check = await users.alice.client.from('groups').select('name').eq('id', groupId).single();
      assert.equal(check.data.name, `Alice's group ${run}`);
    });

    test('cannot remove members, delete polls or delete votes', async () => {
      const { client } = users.mallory;
      assertBlocked(await client.from('group_members').delete().eq('group_id', groupId).select());
      assertBlocked(await client.from('polls').delete().eq('id', pollId).select());
      assertBlocked(await client.from('votes').delete().eq('poll_id', pollId).select());
    });

    test('cannot rotate the invite code', async () => {
      const { error } = await users.mallory.client.rpc('rotate_group_invite', { p_group_id: groupId });
      assert.equal(error?.code, '42501');
    });

    test('cannot create a group in someone else\'s name', async () => {
      assertRlsViolation(await users.mallory.client.from('groups')
        .insert({ name: 'Framed', created_by: users.alice.id }));
    });

    test('cannot call the private helper functions over the API', async () => {
      const { error } = await users.mallory.client.rpc('my_group_ids');
      assert.ok(error, 'private schema functions must not be reachable');
    });
  });

  describe('a member (Bob) cannot go beyond his own rights', () => {
    test('cannot vote as Alice or change Alice\'s vote', async () => {
      const { client } = users.bob;
      assertRlsViolation(await client.from('votes')
        .insert({ poll_id: pollId, option_id: optionId, user_id: users.alice.id }));
      assertBlocked(await client.from('votes').update({ option_id: optionId })
        .eq('user_id', users.alice.id).select());
      assertBlocked(await client.from('votes').delete().eq('user_id', users.alice.id).select());
    });

    test('cannot make himself an admin', async () => {
      assertRlsViolation(await users.bob.client.from('group_members').update({ role: 'admin' })
        .eq('group_id', groupId).eq('user_id', users.bob.id));
    });

    test('cannot rename the group, remove Alice or rotate the invite', async () => {
      const { client } = users.bob;
      assertBlocked(await client.from('groups').update({ name: 'Bob rules' }).eq('id', groupId).select());
      assertBlocked(await client.from('group_members').delete().eq('group_id', groupId)
        .eq('user_id', users.alice.id).select());
      const { error } = await client.rpc('rotate_group_invite', { p_group_id: groupId });
      assert.equal(error?.code, '42501');
    });

    test('cannot edit Alice\'s profile', async () => {
      assertBlocked(await users.bob.client.from('profiles').update({ display_name: 'hacked' })
        .eq('id', users.alice.id).select());
    });

    test('cannot close a poll or set its outcome directly', async () => {
      assertRlsViolation(await users.bob.client.from('polls').update({ status: 'closed' }).eq('id', pollId));
    });

    test('cannot change votes or suggest options once the poll is closed', async () => {
      assertRlsViolation(await users.bob.client.rpc('close_poll', { p_poll_id: pollId }));
      const closed = await users.alice.client.rpc('close_poll', { p_poll_id: pollId });
      assert.ifError(closed.error);
      const persisted = await users.alice.client.from('polls').select('status, saved_outcome_option_id')
        .eq('id', pollId).single();
      assert.ifError(persisted.error);
      assert.equal(persisted.data.status, 'closed');
      const tieOrder = await users.alice.client.from('options').select('id')
        .eq('poll_id', pollId).order('created_at').order('id');
      assert.ifError(tieOrder.error);
      assert.equal(persisted.data.saved_outcome_option_id, tieOrder.data[0].id);
      const retriedClose = await users.alice.client.rpc('close_poll', { p_poll_id: pollId });
      assert.ifError(retriedClose.error);
      assert.equal(retriedClose.data, tieOrder.data[0].id);

      const emptyPoll = await users.alice.client.from('polls').insert({ group_id: groupId, question: 'No votes?' })
        .select('id').single();
      assert.ifError(emptyPoll.error);
      const emptyOption = await users.alice.client.from('options')
        .insert({ poll_id: emptyPoll.data.id, restaurant_name: 'Quiet Cafe' }).select('id').single();
      assert.ifError(emptyOption.error);
      const zeroTotals = await users.alice.client.rpc('get_vote_totals', { p_poll_id: emptyPoll.data.id });
      assert.ifError(zeroTotals.error);
      assert.deepEqual(zeroTotals.data.map((row) => Number(row.vote_count)), [0]);
      const emptyClose = await users.alice.client.rpc('close_poll', { p_poll_id: emptyPoll.data.id });
      assert.ifError(emptyClose.error);
      assert.equal(emptyClose.data, null);
      const savedEmpty = await users.alice.client.from('polls').select('saved_outcome_option_id')
        .eq('id', emptyPoll.data.id).single();
      assert.ifError(savedEmpty.error);
      assert.equal(savedEmpty.data.saved_outcome_option_id, null);

      const racePoll = await users.alice.client.from('polls').insert({ group_id: groupId, question: 'Close race?' })
        .select('id').single();
      assert.ifError(racePoll.error);
      const raceOption = await users.alice.client.from('options')
        .insert({ poll_id: racePoll.data.id, restaurant_name: 'Race Cafe' }).select('id').single();
      assert.ifError(raceOption.error);
      const [raceClose, raceVote] = await Promise.all([
        users.alice.client.rpc('close_poll', { p_poll_id: racePoll.data.id }),
        users.bob.client.rpc('cast_vote', { p_poll_id: racePoll.data.id, p_option_id: raceOption.data.id }),
      ]);
      assert.ifError(raceClose.error);
      assert.ok(!raceVote.error || raceVote.error.code === '55000', raceVote.error?.message);
      const raceResult = await users.alice.client.from('polls').select('status, saved_outcome_option_id')
        .eq('id', racePoll.data.id).single();
      assert.ifError(raceResult.error);
      assert.equal(raceResult.data.status, 'closed');
      assert.equal(raceResult.data.saved_outcome_option_id,
        raceVote.error ? null : raceOption.data.id, 'a vote is either committed before close and counted, or rejected after close');
      const { client, id } = users.bob;
      const closedVote = await client.rpc('cast_vote', { p_poll_id: pollId, p_option_id: secondOptionId });
      assert.equal(closedVote.error?.code, '55000');
      assertBlocked(await client.from('votes').update({ option_id: optionId }).eq('user_id', id).select());
      assertBlocked(await client.from('votes').delete().eq('user_id', id).select());
      assertRlsViolation(await client.from('options').insert({ poll_id: pollId, restaurant_name: 'Too late' }));
    });
  });

  describe('Express only accepts valid Supabase access tokens', () => {
    let server;
    let base;

    before(async () => {
      process.env.SUPABASE_URL = url;
      process.env.SUPABASE_PUBLISHABLE_KEY = publishableKey;
      const { createApp } = await import('../server/app.js');
      server = createApp().listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}/api`;
    });

    after(() => server?.close());

    const get = (path, token) => fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    test('rejects requests with no token', async () => {
      assert.equal((await get('/groups')).status, 401);
    });

    test('rejects a malformed token', async () => {
      assert.equal((await get('/groups', 'not-a-jwt')).status, 401);
    });

    test('rejects a token signed with the wrong key', async () => {
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'HS256', typ: 'JWT' });
      const payload = encode({
        sub: users.alice.id, role: 'authenticated', aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const signature = createHmac('sha256', 'attacker-chosen-secret').update(`${header}.${payload}`)
        .digest('base64url');
      assert.equal((await get('/groups', `${header}.${payload}.${signature}`)).status, 401);
    });

    test('accepts a real token and applies RLS behind it', async () => {
      const mine = await get('/groups', users.mallory.token);
      assert.equal(mine.status, 200);
      assert.deepEqual((await mine.json()).map((group) => group.id), [strangerGroupId]);
      assert.equal((await get(`/groups/${groupId}`, users.mallory.token)).status, 404);
      assert.equal((await get(`/groups/${groupId}`, users.bob.token)).status, 200);
    });

    test('explains a missing profile instead of failing with a generic error', async () => {
      // Accounts created before the sign-up trigger existed have no profile row.
      const orphan = await createUser('orphan');
      users.orphan = orphan;
      assert.ifError((await admin.from('profiles').delete().eq('id', orphan.id)).error);

      const response = await fetch(`${base}/groups`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${orphan.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No profile' }),
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /no profile yet/);
    });
  });
});
