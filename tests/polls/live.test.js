import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchPoll } from '../../client/src/polls/live.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('events during a snapshot queue another read; stop ignores late responses and cleans up', async () => {
  const pending = [];
  const received = [];
  let changed, cleaned = false;
  const stream = watchPoll({ pollId: 'poll', userId: 'me', events: new EventTarget(), visibility: new EventTarget(),
    repository: { read: () => new Promise((resolve) => pending.push(resolve)), observe: (_, callback) => {
      changed = callback; return () => { cleaned = true; };
    } }, onData: (value) => received.push(value), onError() {}, onStatus() {} });
  try {
    assert.equal(pending.length, 1);
    changed(); changed();
    pending.shift()({ total: 0 });
    await tick();
    assert.equal(pending.length, 1);
    pending.shift()({ total: 2 });
    await tick();
    assert.deepEqual(received, [{ total: 0 }, { total: 2 }]);
    changed();
    stream.stop();
    pending.shift()({ total: 3 });
    await tick();
    assert.equal(received.length, 2);
    assert.ok(cleaned);
  } finally { stream.stop(); }
});

test('failed stream uses fallback and online recovery, even after a read error', async () => {
  const events = new EventTarget();
  const visibility = new EventTarget();
  const statuses = [], errors = [], received = [];
  let reads = 0;
  const stream = watchPoll({ pollId: 'poll', userId: 'me', events, visibility, fallbackMs: 10,
    repository: { observe() { throw new Error('offline'); }, async read() {
      if (++reads === 1) throw new Error('Network unavailable');
      return reads;
    } }, onData: (data) => received.push(data), onError: (error) => errors.push(error), onStatus: (status) => statuses.push(status) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(received.length > 0);
    assert.ok(errors.includes('Network unavailable'));
    const previous = reads;
    events.dispatchEvent(new Event('offline'));
    events.dispatchEvent(new Event('online'));
    await tick();
    assert.ok(reads > previous);
    assert.ok(statuses.includes('offline'));
    assert.ok(statuses.includes('reconnecting'));
  } finally { stream.stop(); }
});
