import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  account, asExistingUser, createGroup, must, pollChanges, readPoll, setupPoll, startApi, subscribed,
} from '../tests/support.js';

function setting(name, fallback, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(name + ' must be between 1 and ' + max);
  return value;
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(2));
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), max: percentile(1) };
}

const clients = setting('BENCH_CLIENTS', 5, 50);
const samples = setting('BENCH_SAMPLES', 8, 25);
const intervalMs = setting('BENCH_POLL_MS', 250, 5_000);
const transport = process.env.BENCH_TRANSPORT ?? 'realtime';
const write = process.env.BENCH_WRITE ?? 'express';
assert.ok(['realtime', 'polling'].includes(transport), 'BENCH_TRANSPORT must be realtime or polling');
assert.ok(['express', 'direct'].includes(write), 'BENCH_WRITE must be express or direct');

const api = await startApi();
const listeners = [];
const intervals = [];
let pending;
let snapshotRequests = 0;
const mutationTimes = [];
const notificationTimes = [];
const snapshotTimes = [];

try {
  const owner = await account();
  const watcher = await account();
  const writers = [];
  for (let i = 0; i < samples; i++) writers.push(await account());
  const group = await createGroup(owner, [watcher, ...writers]);
  const { poll, first } = await setupPoll(owner, group);
  const identity = must(await watcher.client.auth.getSession());
  const readers = await Promise.all(Array.from({ length: clients }, () => asExistingUser(identity)));
  await Promise.all(readers.map(async (client, index) => {
    listeners.push(client);
    async function observe() {
      const sample = pending;
      if (sample && !sample.waiting.has(index)) return;
      if (!sample && transport === 'realtime') return;
      try {
        snapshotRequests++;
        const snapshot = await readPoll({ client }, poll);
        if (sample !== pending || !sample || snapshot.poll.revision < sample.revision) return;
        if (!sample.waiting.delete(index)) return;
        snapshotTimes.push(performance.now() - sample.started);
        if (!sample.waiting.size) sample.resolve();
      } catch (error) {
        sample?.reject(error);
      }
    }

    if (transport === 'polling') {
      intervals.push(setInterval(observe, intervalMs));
    } else {
      await subscribed(pollChanges(client, poll, ({ new: row }) => {
        const sample = pending;
        if (!sample || row.revision !== sample.revision || !sample.waiting.has(index)) return;
        notificationTimes.push(performance.now() - sample.started);
        void observe();
      }));
    }
  }));

  for (let index = 0; index < samples; index++) {
    let timeout;
    const done = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for snapshot ' + (index + 1))), 15_000);
      pending = {
        started: performance.now(), revision: index + 3, resolve, reject,
        waiting: new Set(readers.keys()),
      };
    });
    try {
      const writeVote = async () => {
        if (write === 'express') {
          const response = await api.call(writers[index], '/polls/' + poll + '/votes', { optionId: first });
          assert.equal(response.status, 201, response.error);
        } else {
          must(await writers[index].client.rpc('cast_dining_vote', { p_poll: poll, p_option: first }));
        }
        mutationTimes.push(performance.now() - pending.started);
      };
      await Promise.all([done, writeVote()]);
    } finally {
      clearTimeout(timeout);
      pending = undefined;
    }
  }

  console.log(JSON.stringify({
    clients, samples, transport, write,
    ...(transport === 'polling' && { intervalMs }),
    snapshotRequests,
    mutationResponseMs: summary(mutationTimes),
    ...(notificationTimes.length && { notificationMs: summary(notificationTimes) }),
    freshSnapshotMs: summary(snapshotTimes),
  }, null, 2));
} finally {
  intervals.forEach(clearInterval);
  await Promise.all(listeners.map((client) => client.removeAllChannels()));
  await api.close();
}
