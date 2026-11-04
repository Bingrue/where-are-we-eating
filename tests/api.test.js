import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';

const poll = randomUUID();
const option = randomUUID();
const calls = [];
let server;
let base;

before(async () => {
  const app = createApp({
    supabaseUrl: 'http://127.0.0.1:54321',
    gateway: {
      authenticate: async (token) => token === 'valid',
      async run(token, name, args) {
        calls.push({ token, name, args });
        if (name === 'close_dining_poll') {
          return { error: { code: 'PT403', message: 'Only the poll creator can close this poll.' } };
        }
        return { data: option };
      },
    },
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => server?.close());

function request(path, token, body) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('health is public and responses include security headers', async () => {
  const res = await request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.match(res.headers.get('content-security-policy'), /ws:\/\/127\.0\.0\.1:54321/);
});

test('rejects missing and invalid credentials before a command reaches the database', async () => {
  for (const token of [undefined, 'bad']) {
    assert.equal((await request('/api/polls/' + poll + '/votes', token, { optionId: option })).status, 401);
  }
  assert.equal(calls.length, 0);
});

test('rejects spoofed user IDs, malformed UUIDs and invalid option fields', async () => {
  const path = '/api/polls/' + poll;
  assert.equal((await request(path + '/votes', 'valid', { optionId: option, userId: randomUUID() })).status, 400);
  assert.equal((await request('/api/polls/invalid/votes', 'valid', { optionId: option })).status, 400);
  assert.equal((await request(path + '/options', 'valid', { name: 'Cafe', category: 'Coffee', priceLevel: 5 })).status, 400);
  assert.equal(calls.length, 0);
});

test('forwards the original bearer token and the validated vote arguments', async () => {
  const res = await request('/api/polls/' + poll + '/votes', 'valid', { optionId: option });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { data: option });
  assert.deepEqual(calls.at(-1), {
    token: 'valid', name: 'cast_dining_vote', args: { p_poll: poll, p_option: option },
  });
});

test('maps safe database errors and responds to malformed JSON', async () => {
  const res = await request('/api/polls/' + poll + '/close', 'valid', {});
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /poll creator/);
  const malformed = await fetch(base + '/api/groups', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await request('/api/no-such-route', 'valid')).status, 404);
});
