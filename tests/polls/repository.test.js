import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPollRepository } from '../../client/src/polls/repository.js';

test('vote and close use the task 5 RPC contract and never write votes directly', async () => {
  const calls = [];
  const repository = createPollRepository({ rpc: async (...args) => { calls.push(args); return { error: null }; } });
  await repository.vote('poll', 'option');
  await repository.close('poll');
  assert.deepEqual(calls, [['cast_vote', { p_poll_id: 'poll', p_option_id: 'option' }], ['close_poll', { p_poll_id: 'poll' }]]);
});

test('unavailable RPC and database rejections surface to the UI', async () => {
  for (const code of ['PGRST202', '42883']) {
    const repository = createPollRepository({ rpc: async () => ({ error: { code } }) });
    await assert.rejects(repository.vote('p', 'o'), /not available yet/);
  }
  const repository = createPollRepository({ rpc: async () => ({ error: { code: '42501', message: 'Poll closed' } }) });
  await assert.rejects(repository.vote('p', 'o'), /Poll closed/);
});

test('read preserves the database saved winner and handles zero counts and own vote', async () => {
  const poll = { id: 'p', status: 'closed', saved_outcome_option_id: 'earlier', options: [
    { id: 'later', created_at: '2026-11-19', votes: [{ count: 3 }] },
    { id: 'earlier', created_at: '2026-11-18', votes: [] },
  ] };
  const client = { from(table) {
    const query = { select() { return this; }, eq() { return this; },
      async single() { return { data: poll }; }, async maybeSingle() { return { data: { option_id: 'later' } }; } };
    assert.ok(['polls', 'votes'].includes(table));
    return query;
  } };
  const data = await createPollRepository(client).read('p', 'me');
  assert.equal(data.saved_outcome_option_id, 'earlier');
  assert.equal(data.options[0].vote_count, 0);
  assert.equal(data.options[1].vote_count, 3);
  assert.equal(data.my_option_id, 'later');
});


test('subscriptions stay poll-filtered, wait for the database stream, and clean up', () => {
  const bindings = [], statuses = [];
  let subscribe, system, removed = false;
  const channel = { on(type, filter, callback) {
    if (type === 'system') system = callback;
    else bindings.push(filter);
    return this;
  }, subscribe(callback) { subscribe = callback; return this; } };
  const repository = createPollRepository({ channel: () => channel, removeChannel(value) { assert.equal(value, channel); removed = true; } });
  const stop = repository.observe('p', () => {}, (value) => statuses.push(value));
  assert.equal(bindings.length, 5);
  assert.ok(bindings.every((binding) => binding.schema === 'public' && binding.filter === (binding.table === 'polls' ? 'id=eq.p' : 'poll_id=eq.p')));
  subscribe('SUBSCRIBED');
  assert.deepEqual(statuses, []);
  system({ extension: 'postgres_changes', status: 'ok' });
  assert.deepEqual(statuses, ['live']);
  subscribe('CHANNEL_ERROR');
  assert.deepEqual(statuses, ['live', 'reconnecting']);
  stop(); assert.equal(removed, true);
});
