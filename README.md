# Where Are We Eating?

A private restaurant polling app for dinner plans. Create a dining group, invite friends, suggest restaurants by cuisine and price, vote once per poll, and watch totals update across sessions. The poll creator closes voting and saves the result for the group.

This implements the Group 22 CS 9538 Databases II proposal at Western University. The repository includes the Vite + React frontend, Express API, Supabase migration, automated tests, and reproducible query and latency benchmarks.

## Quick start

Install Node.js 24 (22.12 or newer also works), npm, and a running Docker-compatible container engine such as Docker Desktop. Run the following from the repository root.

```sh
npm ci
npm run db -- start
npm run db -- status
```

Copy the environment templates. Use the code block for your shell.

```sh
cp client/.env.example client/.env
cp server/.env.example server/.env
cp .env.test.example .env.test
```

```powershell
Copy-Item client/.env.example client/.env
Copy-Item server/.env.example server/.env
Copy-Item .env.test.example .env.test
```

From the Supabase status output, copy the Project or API URL and the publishable key (the legacy `anon` key also works) into the corresponding variables in all three files.

| File | URL variable | Key variable |
| --- | --- | --- |
| `client/.env` | `VITE_SUPABASE_URL` | `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `server/.env` | `SUPABASE_URL` | `SUPABASE_PUBLISHABLE_KEY` |
| `.env.test` | `TEST_SUPABASE_URL` | `TEST_SUPABASE_KEY` |

The application uses public project credentials and each user's JWT. Keep secret and service-role keys out of these files and the frontend bundle.

```sh
npm run dev
```

Open [the app](http://localhost:5173). Express listens on port 3000, and Vite proxies requests under `/api`. Supabase Studio is available at [port 54323](http://127.0.0.1:54323). Local email confirmation is disabled so test accounts can sign in immediately.

1. Create an account and a private dining group. Open **Show invite** and copy the invitation link.
2. Open the link in a separate browser profile, register a second account, and select **Join group**.
3. Create a poll in the first session and add a restaurant. Open the poll in both sessions.
4. Vote in the second session. The first session should show the new count without a refresh.
5. Close the poll from the creator's session. Both sessions should see the result, and the group poll list should show the winner.

Use `npm run db -- stop` to stop the local stack. To erase local app data and reapply migrations, run `npm run db -- reset`.

## Hosted Supabase and production build

1. Create a Supabase project. From the repository root run `npm run db -- login`, `npm run db -- link --project-ref YOUR_PROJECT_REF`, and `npm run db -- push`.
2. Enable email sign-up and password login. In **Authentication → URL Configuration**, set the Site URL to your deployed origin. Add allowed redirect URLs for that origin, including the dashboard with invitation query strings and group or poll links if you want confirmation to return users to those pages. Configure production email delivery in Supabase.
3. Set the production Supabase URL and public key in the client environment **before building** and in the Express environment **before starting**. Use one web origin for the built frontend and its `/api` routes.

```sh
npm ci
npm run build
npm start
```

Express serves `client/dist` and supports direct navigation to React routes. Put it behind HTTPS in production. Set `PORT` for the listener and set `TRUST_PROXY_HOPS` to the number of trusted proxy hops only if your network topology guarantees it. In development, update the Vite proxy target if you change the API port. The per-IP Express command limit is in memory for each server instance.

## Architecture

```mermaid
sequenceDiagram
    participant V as Voter's React app
    participant E as Express
    participant A as Supabase Auth
    participant D as PostgREST / PostgreSQL
    participant R as Supabase Realtime
    participant M as Member's React app
    V->>A: Sign in and receive access token
    V->>E: POST vote with bearer token
    E->>A: Validate token
    E->>D: Invoke cast_dining_vote with the same token
    D->>D: Lock poll, validate membership and option, insert vote
    D->>D: Increment poll revision and commit
    D-->>E: Vote accepted
    E-->>V: HTTP 201
    D-->>R: Committed poll update via logical replication
    R-->>M: RLS-filtered change notification
    M->>D: Read a fresh poll snapshot
```

React uses Supabase Auth for registration and sign-in. Reads of the group list and poll history go directly to the Supabase Data API with RLS. Express validates command inputs, authenticates the caller with Supabase Auth, and forwards the original JWT to the database function. The SQL functions also validate identity and permissions so a direct RPC call has the same database rules. The migration restricts the browser's table privileges to reads. Supabase's [RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security) and [database functions guide](https://supabase.com/docs/guides/database/functions) describe these controls.

### Data model

| Table | Purpose and integrity |
| --- | --- |
| `profiles` | One application profile per Auth user. A trigger creates it on registration. |
| `groups` | Private groups with a creator and a randomly generated reusable invitation code. |
| `group_members` | Unique membership per user and group, with owner or member role. |
| `polls` | Group, creator, question, status, revision, closure time, and frozen outcome. A composite foreign key requires the creator to belong to the group. |
| `options` | Restaurant name, food category, and price level 1–4. Restaurant names are unique per poll ignoring case and surrounding spaces. |
| `votes` | One immutable choice per user and poll. A composite foreign key enforces that the option belongs to that poll. |

### Security and transaction rules

- RLS limits group, roster, poll, and option reads to group members. Profiles and individual vote rows are visible only to their owners. Group members can see aggregate counts through a membership-checked snapshot.
- The group owner can retrieve its invitation code. A signed-in person with the code can join as a member. The code is excluded from direct table reads. Send invitation links only to intended participants because recipients can forward them.
- The command RPCs derive the actor from `auth.uid()`. They run with an empty search path and explicit execute grants for `authenticated`. Their helpers live in a schema outside the exposed Data API. Browser roles have zero direct write privileges on the six tables.
- Vote, suggestion, and close operations take the same poll row lock. A vote that obtains the lock first commits before close can compute the outcome. A vote that obtains it after close sees the closed status and fails. A primary key on `(poll_id, user_id)` enforces one vote even under concurrent duplicate requests.
- Closing requires the poll creator's identity. Retrying close returns the saved outcome. The highest count wins. Ties go to the earliest suggestion, then the smallest UUID if timestamps match. A poll with zero votes closes without a winner. Closed totals are read from the saved snapshot.
- Membership is additive. The app does not expose deletion or membership removal. Database foreign keys restrict deletion of Auth accounts with linked domain records, so handle account cleanup with an explicit data-retention procedure in production.

### Realtime and recovery

An accepted vote or suggestion increments the poll revision in the same transaction as its data change. Closing updates that same poll row. Supabase Realtime listens to the PostgreSQL write-ahead log through logical replication and forwards the committed poll change over WebSockets to clients permitted by poll RLS. Individual vote rows stay out of the Realtime publication.

The event tells the browser to fetch `dining_poll_snapshot`. The database joins options to aggregate vote counts and returns the caller's own choice plus the current revision. The browser coalesces closely spaced events and refreshes when the database stream reports readiness and when the tab becomes visible. In a visible tab it also checks every five seconds while disconnected and every 30 seconds while connected to recover any missed changes. [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)

The same feature in an Express-only authorization design would need permission checks on every data path and its own push or polling mechanism. In this app, both Express and direct Data API clients share database rules. Costs include RLS checks during Realtime fan-out, an extra snapshot read after each burst of notifications, and serial writes to the same poll row. Writes to different polls use different locks. The benchmarks below isolate several of these costs.

## API

Send `Authorization: Bearer <access-token>` and use JSON request bodies for commands. Successful commands return `{"data": ...}`. Failures return `{"error": "..."}`.

| Method and route | Body | Success |
| --- | --- | --- |
| `GET /api/health` | — | 200, health status |
| `POST /api/groups` | `{ "name": "Friday dinner" }` | 201, group ID |
| `POST /api/groups/join` | `{ "invite": "<code>" }` | 200, group ID |
| `GET /api/groups/:id/invite` | — | 200, invitation code |
| `POST /api/groups/:id/polls` | `{ "question": "Where should we eat?" }` | 201, poll ID |
| `POST /api/polls/:id/options` | `{ "name": "Juniper Bistro", "category": "French", "priceLevel": 2 }` | 201, option ID |
| `POST /api/polls/:id/votes` | `{ "optionId": "<uuid>" }` | 201, selected option ID |
| `POST /api/polls/:id/close` | `{}` | 200, frozen outcome |

Invalid input returns 400, missing or invalid credentials return 401, a member closing another member's poll receives 403, private resources inaccessible to the caller return 404, and duplicate votes or writes to closed polls return 409. Health only checks the Express process.

## Tests

```sh
npm test
npm run test:integration
```

The first command runs Express tests with a stubbed Supabase gateway. The second needs the local stack and `.env.test`, and exercises real Auth, PostgREST, RLS, Express, and Realtime. Tests cover guessed private IDs, blocked direct writes and forged identities, authorization for closure, same-poll option validation, concurrent duplicate and close races, deterministic ties, zero-vote closure, and recovery after a missed notification. The suites create disposable fixture accounts and groups. Point them at a development database.

The browser test drives the production build through two isolated Chromium sessions. It covers sign-up, sign-in, invitations, suggestions, voting, live totals, and saved results after navigation. It also prints one browser-to-browser latency observation.

```sh
npm run build
npx --no-install playwright install chromium
npm run test:browser
```

GitHub Actions starts a disposable Supabase stack and runs the API, integration, and browser suites along with small benchmark runs.

## Benchmarks

### PostgreSQL query plans

Install the PostgreSQL `psql` client. Get the local database URL from `npm run db -- status`, then run from the repository root.

```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v group_count=100 -v polls_per_group=100 -v voter_count=400 \
  -f benchmarks/query-plans.sql
```

The fixture creates synthetic groups, polls, options, and votes in a transaction. It compares group poll history and grouped vote counts with and without the two workload indexes. It keeps primary, unique, and foreign key constraints in place. It runs a warm-up before each measured plan and rolls back the data and DDL. Run this on a disposable local database because changing indexes takes locks. Record plan shape, estimated versus actual rows, buffer activity, and execution time at multiple scales. PostgreSQL can legitimately favor an existing key or a sequential scan on small datasets.

### Update latency and fan-out

Start the local stack and configure `.env.test`. The benchmark creates a poll, uses a different authenticated voter for each sample, and observes updates from separate authenticated connections. Results are milliseconds measured from starting the vote request on the same machine.

```sh
BENCH_CLIENTS=10 BENCH_SAMPLES=8 npm run benchmark:realtime
BENCH_CLIENTS=10 BENCH_SAMPLES=8 BENCH_TRANSPORT=polling BENCH_POLL_MS=250 npm run benchmark:realtime
BENCH_CLIENTS=10 BENCH_SAMPLES=8 BENCH_WRITE=direct npm run benchmark:realtime
```

In PowerShell, set variables before running the command, for example `$env:BENCH_CLIENTS = '10'` and `$env:BENCH_TRANSPORT = 'polling'`. Remove an override with `Remove-Item Env:BENCH_TRANSPORT`.

Compare p50, p95, and max for the write response, notification receipt, and the first fresh snapshot, plus the total snapshot requests. Use the same sample count and reader count for each comparison. Change only `BENCH_WRITE` to estimate the Express hop and Auth verification overhead. Change only `BENCH_TRANSPORT` to compare push with periodic snapshot polling. The benchmark uses clients subscribed as one authorized reader across multiple connections, with separate voters for the writes. The browser test measures the user-facing flow separately, including rendering and the UI's event debounce. Measure on the deployment you want to characterize. Latency depends on load, network placement, and local hardware.

## Repository layout

| Path | Contents |
| --- | --- |
| `client/` | React screens, Auth client, and Realtime subscriptions |
| `server/` | Express routes, request validation, and JWT-scoped RPC calls |
| `supabase/` | Local configuration and six-table database migration |
| `tests/` | Express, Supabase integration, and two-session browser suites |
| `benchmarks/` | Query plan, Realtime, and polling workloads |
| `.github/workflows/` | Continuous integration |

## Push a copy to GitHub

From an extracted copy of the project, create an empty repository in GitHub, then run the commands below with your repository URL.

```sh
git init -b main
git add .
git commit -m "Build Where Are We Eating"
git remote add origin https://github.com/YOUR_ACCOUNT/where-are-we-eating.git
git push -u origin main
```
