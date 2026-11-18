// Task 6: measure real Supabase vote-to-visible latency. No mocked measurements.
// Requires task 5 RPCs and local Supabase; see docs/bingrui-handoff.md.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { createPollRepository } from '../client/src/polls/repository.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
assert.ok(url && key && secret, 'Set local Supabase credentials in .env.test (see .env.test.example).');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Run benchmarks against local Supabase only.');
const sizes = (process.env.BENCH_USERS ?? '1,5,10,25,50').split(',').map(Number);
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
const intervalMs = Number(process.env.BENCH_POLL_MS ?? 1000);
assert.ok(sizes.length && sizes.every((n) => Number.isInteger(n) && n >= 1 && n <= 50), 'BENCH_USERS must contain integers from 1 to 50.');
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 100, 'BENCH_SAMPLES must be 1–100.');
assert.ok(Number.isInteger(intervalMs) && intervalMs >= 100 && intervalMs <= 10000, 'BENCH_POLL_MS must be 100–10000.');
const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(url, secret, { auth });
const identities = [];
const rows = [];
let groupId;
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function percentile(values, p) {
  const sorted = [...values].sort((a,b) => a-b);
  return Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2));
}

try {
  // Different authenticated identities, not 50 copies of one user's token.
  for (let i = 0; i <= Math.max(...sizes); i++) {
    const email = `latency-${randomUUID()}@example.com`, password = `Bench!${randomUUID()}`;
    const user = must(await admin.auth.admin.createUser({ email, password, email_confirm: true })).user;
    identities.push({ id: user.id }); // cleanup even if sign-in fails
    const client = createClient(url, key, { auth });
    must(await client.auth.signInWithPassword({ email, password }));
    Object.assign(identities.at(-1), { client, repository: createPollRepository(client) });
  }
  const owner = identities[0];
  const group = must(await owner.client.from('groups').insert({ name: 'Task 6 latency benchmark' }).select('id, invite_code').single());
  groupId = group.id;
  for (const user of identities.slice(1)) must(await user.client.rpc('join_group', { p_invite_code: group.invite_code }));

  for (const users of sizes) {
    for (const transport of ['realtime', 'polling']) {
      const poll = await owner.repository.create(groupId, `${users} users / ${transport}`);
      for (const restaurant_name of ['Option A', 'Option B']) await owner.repository.suggest(poll.id, { restaurant_name });
      const snapshot = await owner.repository.read(poll.id, owner.id);
      const readers = identities.slice(1, users + 1);
      const stop = [], timers = [];
      let pending = null, requests = 0;
      const observations = [], mutations = [];
      try {
        async function observe(reader, index) {
          const sample = pending;
          if (!sample || !sample.waiting.has(index)) return;
          requests++;
          const data = await reader.repository.read(poll.id, reader.id);
          if (pending !== sample || !sample.waiting.has(index)) return;
          if (data.options.find((option) => option.id === sample.optionId)?.vote_count !== 1) return;
          sample.waiting.delete(index);
          observations.push(performance.now() - sample.started);
          if (!sample.waiting.size) sample.resolve();
        }
        if (transport === 'realtime') {
          await Promise.all(readers.map((reader, index) => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Postgres Changes not ready; check publication/RLS.')), 20000);
            timers.push(timeout);
            const off = reader.repository.observe(poll.id, () => {
              void observe(reader, index).catch((error) => pending?.reject(error));
            }, (status) => { if (status === 'live') { clearTimeout(timeout); resolve(); } });
            stop.push(off);
          })));
        } else {
          readers.forEach((reader, index) => timers.push(setInterval(() => {
            void observe(reader, index).catch((error) => pending?.reject(error));
          }, intervalMs)));
        }
        for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
          const optionId = snapshot.options[sampleIndex % 2].id;
          let timeout;
          const done = new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Fresh snapshot timed out after 20s.')), 20000);
            pending = { optionId, started: performance.now(), waiting: new Set(readers.map((_, i) => i)), resolve, reject };
          });
          try {
            const write = owner.repository.vote(poll.id, optionId).then(() => mutations.push(performance.now() - pending.started));
            await Promise.all([done, write]);
          } finally { clearTimeout(timeout); pending = null; }
          await sleep(100);
        }
        const row = { users, transport, samples, interval_ms: transport === 'polling' ? intervalMs : 0,
          observations: observations.length, snapshot_requests: requests,
          p50_ms: percentile(observations, .5), p95_ms: percentile(observations, .95), max_ms: percentile(observations, 1),
          mutation_p50_ms: percentile(mutations, .5) };
        rows.push(row);
        console.log(JSON.stringify(row));
      } finally { timers.forEach(clearTimeout); stop.forEach((off) => off()); }
    }
  }
  await mkdir('benchmarks/results', { recursive: true });
  const columns = Object.keys(rows[0]);
  await writeFile('benchmarks/results/realtime-latency.csv', [columns.join(','), ...rows.map((row) => columns.map((key) => row[key]).join(','))].join('\n') + '\n');
  await writeFile('benchmarks/results/realtime-latency.json', JSON.stringify({ measured_at: new Date().toISOString(), url, rows }, null, 2) + '\n');
} finally {
  const failures = [];
  if (groupId) { const { error } = await admin.from('groups').delete().eq('id', groupId); if (error) failures.push(error.message); }
  for (const user of identities) {
    await user.client?.removeAllChannels();
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) failures.push(error.message);
  }
  if (failures.length) throw new Error(`Benchmark cleanup failed: ${failures.join('; ')}`);
}
