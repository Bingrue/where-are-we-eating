# Where Are We Eating?

A group restaurant polling app with a React frontend, an Express API, and Supabase for the database, sign-in and row level security.

## Run the app

Use Node.js 24. From the repository root, run:

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend runs on port 5173 and the API runs on port 3000. Check [http://localhost:3000/api/health](http://localhost:3000/api/health) to see the API and Supabase connection status.

## Connect to Supabase

Both the browser and the API use the project URL and the **publishable** key. Copy the examples and fill them in:

```bash
cp client/.env.example client/.env
cp server/.env.example server/.env
```

Get the values from your Supabase project's **Connect** dialog or **Project Settings → API Keys**, or from `npm run db -- status` for local Supabase. Restart `npm run dev` after changing them. Never put the secret (service role) key in either file: the app does not need it.

## Database migrations

The schema lives in `supabase/migrations/`:

| Migration | What it does |
| --- | --- |
| `20261114000000_core_schema.sql` | The six tables, keys, one-vote-per-user rule, “option belongs to this poll” rule and the profile-on-sign-up trigger (task 2). |
| `20261116000000_groups_and_rls.sql` | Invite codes, `join_group()` and `rotate_group_invite()`, table grants and the row level security policies (task 4). |

Local Supabase applies them automatically on `npm run db -- start` and `npm run db -- db reset`. To apply them to the hosted project with the Supabase CLI, first log in and link the project:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

The hosted project already contains the core schema, so mark that migration as applied once instead of running it again:

```bash
npx supabase migration repair --status applied 20261114000000
```

Then push the remaining migrations:

```bash
npx supabase db push
```

## How sign-in works (Supabase Auth)

- The React app signs users up and in with `supabase.auth.signUp()` and `supabase.auth.signInWithPassword()`. The username and display name are sent as user metadata, and the `on_auth_user_created` trigger copies them into `public.profiles`.
- Supabase Auth stores the session in the browser, refreshes the access token before it expires, and reports changes through `onAuthStateChange`. Password resets use `resetPasswordForEmail()` and `updateUser()`.
- Every API request sends `Authorization: Bearer <access token>`. Express verifies it with `supabase.auth.getClaims()` (`server/auth.js`) and rejects missing, expired or forged tokens with 401.
- Express then queries Supabase **as that user** by forwarding the same token, so `auth.uid()` is the user's id and row level security applies to every query. Express never bypasses RLS.

## Groups and row level security

- Creating a group inserts into `groups`; a trigger makes the creator its admin.
- Invite links look like `/join/<code>`. The code is 32 random hex characters, and only `join_group(code)` can add someone to a group. Admins can replace the code with **New link**.
- Policies let users read only the groups they belong to and the polls, options, votes and profiles of those groups. Members can create polls, suggest options and cast, change or remove their own vote while a poll is open. Admins can rename or delete the group and remove members.
- Signed-out (`anon`) requests have no table privileges at all.

### Attack tests

`tests/rls-attacks.test.js` calls the Supabase API directly as three users (an admin, a member and an outsider) and checks that every attempt to read or change another group's data is blocked. It also checks that Express rejects missing, malformed and forged tokens. Run it against local Supabase:

```bash
npm run db -- start
cp .env.test.example .env.test
npm run test:rls
```

Fill `.env.test` with the API URL, publishable key and secret key from `npm run db -- status`. The secret key is used only to create and delete the test users.

### Cost of RLS

`benchmarks/rls-cost.js` seeds three data sizes (50, 500 and 5,000 groups) inside a transaction that is rolled back. It times the app's main queries under RLS and as hand-written membership checks with RLS bypassed, which is what an Express-only app would do. Run it against local Supabase:

```bash
npm run bench:rls
```

Results are written to `benchmarks/results/rls-cost.csv`, with query plans in `benchmarks/results/rls-plans.txt`.

## Use local Supabase

Install and start Docker, then run from the repository root:

```bash
npm run db -- start
npm run db -- status
```

Use the local API URL and publishable key shown by `status` in `client/.env` and `server/.env`. Local Supabase Studio is at [http://127.0.0.1:54323](http://127.0.0.1:54323), and emails sent by local Auth (confirmations, password resets) appear at [http://127.0.0.1:54324](http://127.0.0.1:54324). Stop the stack when finished:

```bash
npm run db -- stop
```

## Poll screens and live updates (Bingrui)

Open a group to create a restaurant poll, suggest restaurants, vote and view the
saved result. Poll screens subscribe to Supabase Postgres Changes and recover
missed updates after reconnecting. The additional migration
`20261118000000_poll_realtime.sql` enables publication of existing poll data;
it does not change RLS policies.

Vote/close actions require Devon's task 5 functions. Their proposed RPC contract,
frontend and real Realtime tests, CI setup and the 1–50-user latency comparison
are documented in [Bingrui's handoff](docs/bingrui-handoff.md).

```bash
npm test
npm run build
npx playwright install chromium
npm run test:browser
# Requires local Supabase credentials in .env.test:
npm run test:realtime
# Also requires Devon's vote RPC:
npm run bench:realtime
```

Browser tests use a fake transport to check frontend behavior. Real Realtime
integration and latency tests are separate commands; no real latency claim is
made by the frontend test suite.
