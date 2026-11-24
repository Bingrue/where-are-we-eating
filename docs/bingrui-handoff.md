# Bingrui: tasks 1 and 6

> This is the handoff note written when tasks 1 and 6 were delivered (Nov 18), kept as a
> record of that work. Statements about what was pending or unverified describe that
> date: all branches are now merged, and the tests and benchmarks below have since been
> run against local Supabase. For the current state of the project see
> [architecture.md](architecture.md), [supabase.md](supabase.md) and
> [development.md](development.md).

## Baseline and ownership

This branch starts at Albion's existing `albi` commit
`c115efe4ae9cf1bf601154015373be2345bf3e0e` (PR #1), which itself includes current
`main` (`99afb5f`). Albion's authentication, groups, core-schema recording and RLS
remain his work. Merge PR #1 before merging these frontend changes, or review this
branch with `albi` as the base. Do not present the whole main-to-branch diff as
Bingrui's contribution.

Bingrui adds the poll components, data adapter, live subscription/recovery logic,
Realtime publication migration, frontend tests/CI and latency benchmark. Task 5
was still pending at the time of this handoff; its database functions and
performance benchmark are now added in this checkout. No task 2 schema, task 3
authentication or task 4 policies are replaced here. No app code uses a secret key.

## What works with the current schema

- Group poll list and creation.
- Restaurant suggestions with optional category and price range.
- Vote counts, current user's choice and the saved final result.
- Postgres Changes invalidates snapshots for poll updates and option/vote
  inserts/updates. All reads/subscriptions use the authenticated Supabase client
  and Albion's RLS. The frontend does not count event payloads as votes.
- Subscription acknowledgement is required before displaying “Live updates”.
- Reads are serialized, with a queued read if changes arrive during an in-flight
  request. Reconnection and the browser's `online`/visibility events refresh the
  snapshot. Fallback reads run every 5 seconds if the stream isn't confirmed;
  a 30-second reconciliation also catches missed events and deletes.
- No DELETE subscription is used: Supabase cannot filter delete events. Periodic
  snapshots reconcile deletes without treating unfiltered events as private data.

Apply `20261118000000_poll_realtime.sql` after the two teammate migrations to add
the existing `polls`, `options` and `votes` tables to `supabase_realtime`. It makes
no table, privilege or policy changes.

## Task 5 voting contract

The database implementation is in `20261119000000_voting_functions_and_indexes.sql`.
The authenticated RPC contract is:

| Action | RPC | Arguments | Result |
| --- | --- | --- | --- |
| Cast/change own vote | `cast_vote` | `p_poll_id uuid`, `p_option_id uuid` | `void`; UI refetches |
| Close poll | `close_poll` | `p_poll_id uuid` | Winning option UUID, or null when no votes |
| Read vote totals | `get_vote_totals` | `p_poll_id uuid` | One row per option with its vote count |

Both write functions lock the poll row, serializing votes against close. Votes
require group membership and an open poll; a change upserts the same user's vote.
Only the creator can close. Ties go to the earliest option by `created_at`, then
UUID; with no votes the saved outcome is null. Authenticated table write grants
on `votes` are revoked, so clients must use `cast_vote`. The UI displays the saved
choice and does not choose a winner itself. Close retries return the saved result.

`get_vote_totals` is used by the repository read path; individual vote rows
remain protected by RLS. `benchmarks/voting-performance.js` compares the total
query with and without `votes_poll_option_idx` at three dataset sizes and emits a
CSV, SVG chart and plans. Run it with `npm run bench:voting` against local
Supabase; see `docs/task5-voting-performance.md` for details.

## Verification

Use Node 24 (`.nvmrc`).

```bash
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`npm test` checks the live-read queue/recovery/cleanup and adapter behavior.
Playwright tests run the production poll components with an explicitly fake
shared data source: two pages suggest/vote/change votes, disconnect/reconnect,
close and reload; a 390px viewport checks creation, RPC errors and offline
controls. They are frontend tests, not evidence of Supabase security, task 5's
locking correctness or real WebSocket latency. The fixture lives under `tests/`
and is not part of the production build.

Real Postgres Changes integration (no task 5 functions needed):

```bash
npm run db -- start
cp .env.test.example .env.test
# Fill LOCAL URL, publishable and secret keys from: npm run db -- status
npm run test:realtime
```

This test creates two authenticated users, creates/joins a group, subscribes to
Postgres Changes, suggests a restaurant and asserts the other user reads it with
a zero-vote count. It cleans up the fixture group and accounts. It fails on missing
configuration instead of silently reporting a skipped integration test as success.

CI runs frontend checks and a separate Docker/Supabase migration + Realtime
integration job. Workflow success must be checked after pushing; a local build
does not prove that the remote workflow has run.

## Task 6 realtime latency experiment

```bash
# Same LOCAL .env.test credentials as above. Never use a shared/hosted database.
npm run bench:realtime
```

Defaults: 1, 5, 10, 25 and 50 separately authenticated observing users, plus one
writer; 5 vote changes per workload; compare Postgres Changes against 1000ms
polling. Override `BENCH_USERS`, `BENCH_SAMPLES`, `BENCH_POLL_MS` in `.env.test`.
For a quick smoke run use `BENCH_USERS=1 BENCH_SAMPLES=2 npm run bench:realtime`.
At least two samples verify both initial vote and vote change behavior.

Output: `benchmarks/results/realtime-latency.csv` and `.json`. Each row records
transport, observing users, sample count, snapshot request count, vote-to-visible
p50/p95/max, and median RPC response time. Vote-to-visible includes the mutation,
event/poll delivery and snapshot read; it is not pure WebSocket latency. No fallback
polling runs during the Realtime benchmark, so a broken subscription fails instead
of producing a misleading Realtime number. These results are a local latency
experiment, not a production load certification. Increase samples for the report.

The benchmark creates local test users and groups and deletes them in `finally`.
If interrupted by process termination, remove leftover `latency-*` users and their
“Task 6 latency benchmark” groups from local Supabase before repeating.

## Status of this delivery

At the time of the task 6 delivery, the local production build, six unit tests and
two Playwright frontend tests passed. In the current task 5 environment, local
Supabase and `.env.test` are unavailable, so database integration checks and
measured voting-performance chart output still need to be generated there.
Authentication/groups still depend on merging Albion's PR #1.
