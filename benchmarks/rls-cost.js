// Measures what row level security costs (task 4).
//
// For three data sizes it seeds synthetic users, groups, polls, options and votes,
// then times the app's typical queries two ways:
//   rls       as the `authenticated` role with a user's JWT claims, so RLS filters rows
//             (how the app really runs: Express forwards the user's token to Supabase)
//   app_check as the table owner (RLS bypassed) with the same membership check written
//             into the query by hand (how an Express-only app without RLS would do it)
// Each size runs inside a transaction that is rolled back, so nothing is left behind.
//
// Run it against LOCAL Supabase (it inserts into auth.users):
//   npm run db -- start
//   npm run bench:rls
// DATABASE_URL defaults to the local stack. Results go to benchmarks/results/.
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const runs = Number(process.env.BENCH_RUNS ?? 30);
const warmup = 5;
const resultsDir = new URL('./results/', import.meta.url);

// groups at each size; every group has 8 members, 4 polls, 5 options per poll,
// and every member votes in every poll. Each user belongs to about 3 groups.
const sizes = [
  { name: 'small', groups: 50 },
  { name: 'medium', groups: 500 },
  { name: 'large', groups: 5000 },
];
const membersPerGroup = 8;
const groupsPerUser = 3;

const queries = [
  {
    name: 'list my groups',
    rls: 'select id, name from public.groups order by name',
    appCheck: `select g.id, g.name from public.groups g
      join public.group_members m on m.group_id = g.id
      where m.user_id = $1 order by g.name`,
  },
  {
    name: 'polls in a group',
    rls: 'select id, question, status from public.polls where group_id = $2 order by created_at desc',
    appCheck: `select id, question, status from public.polls where group_id = $2
      and exists (select 1 from public.group_members m where m.group_id = $2 and m.user_id = $1)
      order by created_at desc`,
  },
  {
    name: 'vote totals for a poll',
    rls: `select o.id, o.restaurant_name, count(v.id) as votes
      from public.options o left join public.votes v on v.option_id = o.id and v.poll_id = o.poll_id
      where o.poll_id = $3 group by o.id, o.restaurant_name order by votes desc`,
    appCheck: `select o.id, o.restaurant_name, count(v.id) as votes
      from public.options o left join public.votes v on v.option_id = o.id and v.poll_id = o.poll_id
      where o.poll_id = $3
        and exists (select 1 from public.polls p join public.group_members m on m.group_id = p.group_id
                    where p.id = $3 and m.user_id = $1)
      group by o.id, o.restaurant_name order by votes desc`,
  },
  {
    name: 'members with profiles',
    rls: `select m.user_id, m.role, p.display_name from public.group_members m
      join public.profiles p on p.id = m.user_id where m.group_id = $2`,
    appCheck: `select m.user_id, m.role, p.display_name from public.group_members m
      join public.profiles p on p.id = m.user_id where m.group_id = $2
        and exists (select 1 from public.group_members me where me.group_id = $2 and me.user_id = $1)`,
  },
];

async function seed(client, groupCount) {
  const userCount = Math.ceil((groupCount * membersPerGroup) / groupsPerUser);
  await client.query(`
    create temp table bench_users on commit drop as
      select gen_random_uuid() as id, n from generate_series(1, $1) n;
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'bench-' || n || '@example.com', jsonb_build_object('display_name', 'User ' || n), now(), now()
      from bench_users;

    create temp table bench_groups on commit drop as
      select gen_random_uuid() as id, n from generate_series(1, $2) n;
    -- The creator trigger makes member slot 0 of each group its admin.
    insert into public.groups (id, name, created_by)
      select g.id, 'Group ' || g.n, u.id
      from bench_groups g join bench_users u on u.n = ((g.n - 1) * $3) % $1 + 1;
    insert into public.group_members (group_id, user_id)
      select g.id, u.id
      from bench_groups g
      cross join generate_series(1, $3 - 1) slot
      join bench_users u on u.n = ((g.n - 1) * $3 + slot) % $1 + 1
      on conflict do nothing;

    insert into public.polls (group_id, created_by, question)
      select g.id, g.created_by, 'Poll ' || p
      from public.groups g, generate_series(1, 4) p;
    insert into public.options (poll_id, restaurant_name)
      select p.id, 'Restaurant ' || o from public.polls p, generate_series(1, 5) o;
    insert into public.votes (poll_id, option_id, user_id)
      select p.id,
        (select o.id from public.options o where o.poll_id = p.id
         order by o.restaurant_name offset (abs(hashtext(m.user_id::text || p.id::text)) % 5) limit 1),
        m.user_id
      from public.polls p join public.group_members m on m.group_id = p.group_id;
    analyze public.profiles, public.groups, public.group_members, public.polls, public.options, public.votes;
  `.replace(/\$1/g, userCount).replace(/\$2/g, groupCount).replace(/\$3/g, membersPerGroup));

  const counts = await client.query(`select
      (select count(*) from public.profiles)::int as profiles,
      (select count(*) from public.groups)::int as groups,
      (select count(*) from public.group_members)::int as group_members,
      (select count(*) from public.polls)::int as polls,
      (select count(*) from public.options)::int as options,
      (select count(*) from public.votes)::int as votes`);

  // A typical user: in the median number of groups.
  const probe = await client.query(`
    select m.user_id, m.group_id, p.id as poll_id
    from public.group_members m join public.polls p on p.group_id = m.group_id
    where m.user_id = (
      select user_id from public.group_members group by user_id
      order by abs(count(*) - $1), user_id limit 1)
    limit 1`, [groupsPerUser]);
  return { counts: counts.rows[0], probe: probe.rows[0] };
}

// The ids are uuids this script read from the database, so they are inlined as literals.
// That also gives both modes the same custom plan instead of a generic prepared plan.
function bind(sql, params) {
  return sql.replace(/\$(\d)/g, (_match, index) => `'${params[index - 1]}'::uuid`);
}

async function explain(client, sql, params) {
  const { rows } = await client.query(`explain (analyze, buffers, format json) ${bind(sql, params)}`);
  const plan = rows[0]['QUERY PLAN'][0];
  return { execution: plan['Execution Time'], planning: plan['Planning Time'], rows: plan.Plan['Actual Rows'] };
}

async function explainText(client, sql, params) {
  const { rows } = await client.query(`explain (analyze, costs off, timing off, summary off) ${bind(sql, params)}`);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function setMode(client, mode, userId) {
  if (mode === 'rls') {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  } else {
    await client.query('reset role');
  }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: at(0.5), p95: at(0.95) };
}

async function measure(client, mode, sql, params, userId) {
  await setMode(client, mode, userId);
  for (let i = 0; i < warmup; i += 1) await explain(client, sql, params);
  const totals = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const result = await explain(client, sql, params);
    totals.push(result.execution + result.planning);
    rows = result.rows;
  }
  const plan = await explainText(client, sql, params);
  await setMode(client, 'app_check');
  return { ...summarize(totals), rows, plan };
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
await mkdir(resultsDir, { recursive: true });

const csv = ['size,groups,votes,query,mode,median_ms,p95_ms,rows'];
const plans = [];

try {
  for (const size of sizes) {
    await client.query('begin');
    try {
      const started = Date.now();
      const { counts, probe } = await seed(client, size.groups);
      console.log(`\n${size.name}: ${JSON.stringify(counts)} (seeded in ${Date.now() - started} ms)`);
      const params = [probe.user_id, probe.group_id, probe.poll_id];

      for (const query of queries) {
        const rls = await measure(client, 'rls', query.rls, params, probe.user_id);
        const app = await measure(client, 'app_check', query.appCheck, params, probe.user_id);
        if (rls.rows !== app.rows) {
          throw new Error(`${query.name}: RLS returned ${rls.rows} rows but the app check returned ${app.rows}`);
        }
        const overhead = rls.median - app.median;
        console.log(`  ${query.name.padEnd(24)} rls ${rls.median.toFixed(3)} ms  app_check ${app.median.toFixed(3)} ms`
          + `  overhead ${overhead >= 0 ? '+' : ''}${overhead.toFixed(3)} ms  (${rls.rows} rows)`);
        for (const [mode, result] of [['rls', rls], ['app_check', app]]) {
          csv.push([size.name, counts.groups, counts.votes, `"${query.name}"`, mode,
            result.median.toFixed(4), result.p95.toFixed(4), result.rows].join(','));
          plans.push(`### ${size.name} / ${query.name} / ${mode}\n${result.plan}\n`);
        }
      }
    } finally {
      await client.query('rollback');
    }
  }
} finally {
  await client.end();
}

await writeFile(new URL('rls-cost.csv', resultsDir), `${csv.join('\n')}\n`);
await writeFile(new URL('rls-plans.txt', resultsDir), plans.join('\n'));
console.log('\nWrote benchmarks/results/rls-cost.csv and benchmarks/results/rls-plans.txt');
