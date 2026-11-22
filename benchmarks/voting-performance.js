// Task 5: EXPLAIN ANALYZE the vote-total query with and without its covering index.
// Every dataset and index change is rolled back. Run only against local Supabase:
//   npm run db -- start
//   npm run bench:voting
// Override VOTE_BENCH_SIZES (comma-separated vote rows) and VOTE_BENCH_RUNS.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const host = new URL(connectionString).hostname;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(host), 'Run the voting benchmark against local Supabase only.');
const sizes = (process.env.VOTE_BENCH_SIZES ?? '1000,10000,50000').split(',').map(Number);
const runs = Number(process.env.VOTE_BENCH_RUNS ?? 10);
assert.ok(sizes.length === 3 && sizes.every((n) => Number.isInteger(n) && n >= 100),
  'VOTE_BENCH_SIZES must contain exactly three integers of at least 100.');
assert.ok(Number.isInteger(runs) && runs >= 3 && runs <= 100, 'VOTE_BENCH_RUNS must be from 3 to 100.');

const client = new pg.Client({ connectionString });
const output = new URL('./results/', import.meta.url);
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const measurements = [];
const plans = [];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function seed(count) {
  await client.query(`
    create temp table vote_bench_users on commit drop as
      select gen_random_uuid() as id, n from generate_series(1, ${count}) n;
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'vote-bench-${runId}-' || n || '@example.com', '{}'::jsonb, now(), now()
      from vote_bench_users;
    create temp table vote_bench_group on commit drop as select gen_random_uuid() as id;
    insert into public.groups (id, name, created_by)
      select g.id, 'Vote benchmark ${runId}', u.id from vote_bench_group g
      cross join vote_bench_users u where u.n = 1;
    create temp table vote_bench_poll on commit drop as select gen_random_uuid() as id;
    insert into public.polls (id, group_id, created_by, question)
      select p.id, g.id, u.id, 'Vote totals benchmark'
      from vote_bench_poll p cross join vote_bench_group g
      cross join vote_bench_users u where u.n = 1;
    create temp table vote_bench_options on commit drop as
      select gen_random_uuid() as id, n from generate_series(1, 8) n;
    insert into public.options (id, poll_id, restaurant_name)
      select o.id, p.id, 'Restaurant ' || o.n
      from vote_bench_options o cross join vote_bench_poll p;
    insert into public.votes (poll_id, option_id, user_id)
      select p.id, o.id, u.id
      from vote_bench_users u cross join vote_bench_poll p
      join vote_bench_options o on o.n = ((hashtext(u.id::text)::bigint & 2147483647) % 8) + 1
      where u.n > 1;
    analyze public.options, public.votes;
  `);
  const { rows: [{ poll_id: pollId, user_id: userId, votes }] } = await client.query(`
    select (select id from vote_bench_poll) as poll_id,
      (select id from vote_bench_users where n = 1) as user_id,
      (select count(*)::int from public.votes v join vote_bench_poll p on p.id = v.poll_id) as votes`);
  return { pollId, userId, votes };
}

async function explain(pollId) {
  const { rows } = await client.query(`explain (analyze, buffers, format json)
    select o.id, o.restaurant_name, pg_catalog.count(v.id) as vote_count
    from public.options o
    left join public.votes v on v.poll_id = o.poll_id and v.option_id = o.id
    where o.poll_id = '${pollId}'::uuid
    group by o.id, o.restaurant_name, o.created_at
    order by o.created_at, o.id`);
  const plan = rows[0]['QUERY PLAN'][0];
  return { executionMs: plan['Execution Time'], planningMs: plan['Planning Time'], plan: plan.Plan };
}

async function measure(label, pollId, userId) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  try {
    for (let i = 0; i < 3; i += 1) await explain(pollId);
    const elapsed = [];
    let last;
    for (let i = 0; i < runs; i += 1) {
      last = await explain(pollId);
      elapsed.push(last.executionMs + last.planningMs);
    }
    const result = { medianMs: median(elapsed), p95Ms: percentile(elapsed, 0.95) };
    plans.push(`## ${label}\n${JSON.stringify(last.plan, null, 2)}\n`);
    return result;
  } finally {
    await client.query('reset role');
  }
}

await client.connect();
await mkdir(output, { recursive: true });
try {
  for (const votesRequested of sizes) {
    await client.query('begin');
    try {
      const { pollId, userId, votes } = await seed(votesRequested + 1);
      // The migration creates this index. Drop it inside the transaction for a
      // true baseline, then restore it for the after measurement; rollback keeps
      // the local database's migrated schema unchanged.
      await client.query('drop index if exists public.votes_poll_option_idx');
      await client.query('analyze public.votes');
      const before = await measure(`votes=${votes} / before index`, pollId, userId);
      await client.query('create index votes_poll_option_idx on public.votes (poll_id, option_id) include (id)');
      await client.query('analyze public.votes');
      const after = await measure(`votes=${votes} / after index`, pollId, userId);
      measurements.push({ votes, before, after });
      console.log(`${votes} votes: ${before.medianMs.toFixed(3)} ms before, ${after.medianMs.toFixed(3)} ms after`);
    } finally {
      await client.query('rollback');
    }
  }
} finally {
  await client.end();
}

const csv = ['votes,before_median_ms,before_p95_ms,after_median_ms,after_p95_ms',
  ...measurements.map(({ votes, before, after }) =>
    [votes, before.medianMs, before.p95Ms, after.medianMs, after.p95Ms].map((n) => Number(n).toFixed(4)).join(','))].join('\n') + '\n';
await writeFile(new URL('voting-performance.csv', output), csv);
await writeFile(new URL('voting-performance-plans.json', output), `${JSON.stringify({ runs, measurements }, null, 2)}\n`);
await writeFile(new URL('voting-performance-plans.txt', output), plans.join('\n'));

// Lightweight standalone chart, generated from the measured medians (no fabricated data).
const width = 760, height = 440, left = 90, right = 30, top = 58, bottom = 82;
const chartW = width - left - right, chartH = height - top - bottom;
const maxY = Math.max(0.01, ...measurements.flatMap(({ before, after }) => [before.medianMs, after.medianMs])) * 1.15;
const xAt = (i) => left + (measurements.length === 1 ? chartW / 2 : i * chartW / (measurements.length - 1));
const yAt = (v) => top + chartH - (v / maxY) * chartH;
const grid = Array.from({ length: 5 }, (_, i) => {
  const value = maxY * i / 4, y = yAt(value);
  return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#d8dee9"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" font-size="12">${value.toFixed(2)}</text>`;
}).join('');
const series = (key, color) => {
  const points = measurements.map((m, i) => `${xAt(i)},${yAt(m[key].medianMs)}`).join(' ');
  const dots = measurements.map((m, i) => `<circle cx="${xAt(i)}" cy="${yAt(m[key].medianMs)}" r="5" fill="${color}"/>`).join('');
  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>${dots}`;
};
const labels = measurements.map((m, i) => `<text x="${xAt(i)}" y="${top + chartH + 24}" text-anchor="middle" font-size="12">${m.votes.toLocaleString()} votes</text>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/><text x="${width / 2}" y="28" text-anchor="middle" font-size="18" font-family="sans-serif">Vote total query: index performance</text>
<text x="${width / 2}" y="48" text-anchor="middle" font-size="12" font-family="sans-serif">median planning + execution time; each point is ${runs} EXPLAIN ANALYZE runs</text>
${grid}<line x1="${left}" y1="${top}" x2="${left}" y2="${top + chartH}" stroke="#334155"/><line x1="${left}" y1="${top + chartH}" x2="${width - right}" y2="${top + chartH}" stroke="#334155"/>
<text transform="translate(20 ${top + chartH / 2}) rotate(-90)" text-anchor="middle" font-size="13">Time (ms)</text>${labels}${series('before', '#c2410c')}${series('after', '#0369a1')}
<line x1="${left + 85}" y1="${height - 25}" x2="${left + 115}" y2="${height - 25}" stroke="#c2410c" stroke-width="3"/><text x="${left + 122}" y="${height - 21}" font-size="12">Before index</text>
<line x1="${left + 250}" y1="${height - 25}" x2="${left + 280}" y2="${height - 25}" stroke="#0369a1" stroke-width="3"/><text x="${left + 287}" y="${height - 21}" font-size="12">After index</text></svg>`;
await writeFile(new URL('voting-performance.svg', output), svg);
console.log('Wrote benchmarks/results/voting-performance.{csv,svg} and plan files.');
