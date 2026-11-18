# Bingrui: tasks 1 and 6

## Baseline and ownership

This branch starts at Albion's existing `albi` commit
`c115efe4ae9cf1bf601154015373be2345bf3e0e` (PR #1), which itself includes current
`main` (`99afb5f`). Albion's authentication, groups, core-schema recording and RLS
remain his work. Merge PR #1 before merging these frontend changes, or review this
branch with `albi` as the base. Do not present the whole main-to-branch diff as
Bingrui's contribution.

Bingrui adds the poll components, data adapter, live subscription/recovery logic,
Realtime publication migration, frontend tests/CI and latency benchmark. No task 2
schema, task 3 authentication, task 4 policies or task 5 database functions are
implemented or replaced here. No application code uses a secret key.

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

## Task 5 handoff — proposed, not yet confirmed

`client/src/polls/repository.js` is the only place to adapt Devon's final RPC
names/arguments. Current proposed authenticated RPC contract:

| Action | RPC | Arguments | Result |
| --- | --- | --- | --- |
| Cast/change own vote | `cast_vote` | `p_poll_id uuid`, `p_option_id uuid` | Any successful response; UI refetches |
| Close poll | `close_poll` | `p_poll_id uuid` | Any successful response; UI refetches |

Required database behavior belongs to Devon: enforce group membership, one vote
per user, option ownership, open-poll checks and locking against close/vote races;
authorize closing; resolve ties; set `polls.status = 'closed'` and persist the
winner in `saved_outcome_option_id`. The UI displays that saved choice and does
not choose a winner itself. A no-vote closure can leave the saved choice null.

Current RLS allows changing an existing vote. This UI offers “Change vote”; if
the team's final rule makes votes immutable, remove that action and adapt the
benchmark's repeated-write fixture with Devon before the final acceptance run.
The close action is shown to the poll creator; its authorization is still the
database's responsibility. No direct vote insertion or client-side close fallback
is provided. A missing RPC produces a user-facing “not available yet” error.

The current read adapter uses RLS-filtered nested `votes(count)` aggregates,
not a download of every individual vote. If Devon supplies a snapshot/totals RPC,
replace `read()` in the adapter with that function, keeping the component's
snapshot shape. Current `read()` uses two queries (poll/options/counts and own
vote), so it is eventually consistent during concurrent writes, not a transaction
snapshot. Task 5 can provide transaction-level snapshot consistency.

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

## Required latency experiment after task 5 is available

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

The local production build, six unit tests and two Playwright frontend tests
have passed. The current machine's user cannot access the Docker socket, so the
real Supabase integration/migration test has not been run locally. No real latency
numbers are supplied. Full voting/closing acceptance and the latency experiment
remain dependent on Devon's task 5 functions. Authentication/groups depend on
merging Albion's PR #1.
