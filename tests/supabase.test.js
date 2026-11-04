import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import {
  account, createGroup, freshClient, must, pollChanges, readPoll, setupPoll, startApi, subscribed,
} from './support.js';

let api;
let owner, member, third, outsider, group;

before(async () => {
  api = await startApi();
  [owner, member, third, outsider] = await Promise.all(Array.from({ length: 4 }, account));
  group = await createGroup(owner, [member, third]);
});
after(() => api?.close());

test('private rows and invitations remain protected through both direct and Express requests', async () => {
  const { poll, first } = await setupPoll(owner, group);
  const { client } = outsider;
  const tables = [
    ['groups', 'id,name', 'id', group],
    ['group_members', '*', 'group_id', group],
    ['polls', '*', 'id', poll],
    ['options', '*', 'poll_id', poll],
    ['votes', '*', 'poll_id', poll],
    ['profiles', '*', 'id', owner.user.id],
  ];
  for (const [table, columns, key, value] of tables) {
    assert.deepEqual(must(await client.from(table).select(columns).eq(key, value)), [], table);
  }

  assert.ok((await member.client.from('groups').select('invite_code').eq('id', group)).error);
  assert.equal((await api.call(member, '/groups/' + group + '/invite')).status, 404);
  const invite = await api.call(owner, '/groups/' + group + '/invite');
  assert.equal(invite.status, 200);
  assert.match(invite.data, /^[a-f0-9]{32}$/);
  assert.equal((await api.call(outsider, '/polls/' + poll + '/votes', { optionId: first })).status, 404);
  assert.equal((await client.rpc('dining_poll_snapshot', { p_poll: poll })).error?.code, 'PT404');
  assert.equal((await client.rpc('create_dining_poll', { p_group: group, p_question: 'Hijack' })).error?.code, 'PT404');
  assert.equal((await member.client.rpc('close_dining_poll', { p_poll: poll })).error?.code, 'PT403');
  assert.equal((await api.call(member, '/polls/' + poll + '/close', {})).status, 403);
  assert.ok((await freshClient().rpc('cast_dining_vote', { p_poll: poll, p_option: first })).error);
  assert.ok((await member.client.from('polls').update({ status: 'closed' }).eq('id', poll)).error);
  assert.ok((await member.client.from('group_members').insert({
    group_id: group, user_id: outsider.user.id, role: 'member',
  })).error);
  for (const user_id of [member.user.id, owner.user.id]) {
    assert.ok((await member.client.from('votes').insert({ poll_id: poll, option_id: first, user_id })).error);
  }
});

test('enforces matching options, duplicate prevention, one vote per identity, and saved ties', async () => {
  const { poll, first, second } = await setupPoll(owner, group);
  const other = await setupPoll(owner, group);
  assert.equal((await api.call(member, '/polls/' + poll + '/votes', { optionId: other.first })).status, 400);
  assert.equal((await api.call(owner, '/polls/' + poll + '/options', {
    name: ' first SUGGESTION ', category: 'Bistro', priceLevel: 2,
  })).status, 409);

  const post = (optionId) => api.call(member, '/polls/' + poll + '/votes', { optionId });
  const duplicates = await Promise.all([post(first), post(first), post(first)]);
  assert.deepEqual(duplicates.map((result) => result.status).sort(), [201, 409, 409]);
  assert.equal((await api.call(owner, '/polls/' + poll + '/votes', { optionId: second })).status, 201);
  assert.deepEqual(must(await member.client.from('votes').select('user_id').eq('poll_id', poll)),
    [{ user_id: member.user.id }]);
  assert.equal((await readPoll(member, poll)).my_option_id, first);

  const result = await api.call(owner, '/polls/' + poll + '/close', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.winner_option_id, first);
  assert.equal(result.data.tied_leaders, 2);
  assert.equal(result.data.total_votes, 2);
  assert.deepEqual((await api.call(owner, '/polls/' + poll + '/close', {})).data, result.data);
  assert.equal((await api.call(third, '/polls/' + poll + '/votes', { optionId: first })).status, 409);
  assert.equal((await api.call(member, '/polls/' + poll + '/options', {
    name: 'Too late', category: 'Bistro', priceLevel: 2,
  })).status, 409);
  assert.deepEqual((await readPoll(third, poll)).outcome, result.data);

  const empty = await api.call(owner, '/polls/' + other.poll + '/close', {});
  assert.equal(empty.data.winner_option_id, null);
  assert.equal(empty.data.tied_leaders, 0);
});

test('the close snapshot includes every concurrent vote that succeeded and rejects every late vote', async () => {
  for (let round = 0; round < 6; round++) {
    const { poll, first, second } = await setupPoll(owner, group);
    const vote = (actor, option) => actor.client.rpc('cast_dining_vote', { p_poll: poll, p_option: option });
    const close = () => owner.client.rpc('close_dining_poll', { p_poll: poll });
    const tasks = [() => vote(member, first), () => vote(third, second), close];
    if (round % 2 === 0) tasks.reverse();
    const replies = await Promise.all(tasks.map((task) => task()));
    if (round % 2 === 0) replies.reverse();
    const [left, right, closed] = replies;
    const outcome = must(closed);
    const accepted = [left, right].filter((reply) => !reply.error);
    assert.equal(outcome.total_votes, accepted.length);
    for (const reply of [left, right]) {
      if (reply.error) assert.equal(reply.error.code, 'PT409');
    }
    for (const option of outcome.options) {
      assert.equal(option.vote_count, accepted.filter((reply) => reply.data === option.id).length);
    }
    assert.equal((await vote(owner, first)).error?.code, 'PT409');
    assert.deepEqual((await readPoll(member, poll)).outcome, outcome);
  }
});

test('Realtime reaches members only, and a fresh snapshot recovers missed updates', { timeout: 35_000 }, async () => {
  const { poll, first, second } = await setupPoll(owner, group);
  let received;
  let outsiderEvents = 0;
  const event = new Promise((resolve) => { received = resolve; });
  const insiderChannel = pollChanges(member.client, poll, received);
  const outsiderChannel = pollChanges(outsider.client, poll, () => { outsiderEvents++; });
  try {
    await Promise.all([subscribed(insiderChannel), subscribed(outsiderChannel)]);
    must(await owner.client.rpc('cast_dining_vote', { p_poll: poll, p_option: first }));
    const update = await Promise.race([event, delay(12_000, null, { ref: false })]);
    assert.equal(update?.new.id, poll);
    assert.equal(update.new.revision, 3);
    assert.equal((await readPoll(member, poll)).options[0].vote_count, 1);
    await member.client.removeChannel(insiderChannel);
    must(await third.client.rpc('cast_dining_vote', { p_poll: poll, p_option: second }));
    must(await owner.client.rpc('close_dining_poll', { p_poll: poll }));
    const reconnect = pollChanges(member.client, poll, () => {});
    try {
      await subscribed(reconnect);
      const snapshot = await readPoll(member, poll);
      assert.equal(snapshot.poll.status, 'closed');
      assert.equal(snapshot.outcome.total_votes, 2);
      assert.equal(outsiderEvents, 0);
    } finally {
      await member.client.removeChannel(reconnect);
    }
  } finally {
    await Promise.all([
      member.client.removeAllChannels(), outsider.client.removeAllChannels(),
    ]);
  }
});
