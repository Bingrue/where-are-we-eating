# Development guide

## Requirements

- **Node.js 24** (`.nvmrc`; `nvm use` picks it up).
- **Docker**, running, for local Supabase.

Install dependencies once from the repository root. This installs the client and server workspaces too:

```bash
npm ci
```

## Environment files

None of these are committed. Each has an example next to it.

| File | Used by | Contains |
| --- | --- | --- |
| `client/.env` | Vite / the browser | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `server/.env` | Express | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `PORT` |
| `.env.test` | Tests and benchmarks | Local `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL` |

`client/.env` and `server/.env` must point at the **same** project. Restart `npm run dev` after changing either.

## Running locally

Start Supabase. The first run downloads several Docker images and takes a few minutes:

```bash
npm run db -- start
```

Print the URL and keys whenever you need them:

```bash
npm run db -- status
```

Put the **API URL** and **publishable key** into `client/.env` and `server/.env`, then:

```bash
npm run dev
```

| URL | What |
| --- | --- |
| [http://localhost:5173](http://localhost:5173) | The app |
| [http://localhost:3000/api/health](http://localhost:3000/api/health) | API status and whether it can reach Supabase |
| [http://127.0.0.1:54323](http://127.0.0.1:54323) | Supabase Studio (browse tables, run SQL, manage users) |
| [http://127.0.0.1:54324](http://127.0.0.1:54324) | Mail catcher for confirmation and password-reset emails |

Local sign-up needs no email confirmation, so you can create test accounts with any address. To try the app as two people, use a second browser or a private window.

Wipe the local database and re-run every migration (all local accounts and data are deleted):

```bash
npm run db -- db reset
```

Stop the containers, keeping the data for next time:

```bash
npm run db -- stop
```

## Using the hosted project

Use this when you want everyone to share the same data, or you cannot run Docker.

1. In the Supabase dashboard open **Connect** (or **Project Settings → API Keys**) and copy the project URL and the publishable key into `client/.env` and `server/.env`.
2. Make sure the hosted database has every migration. See [Applying migrations to the hosted project](supabase.md#applying-migrations-to-the-hosted-project). **If the app signs you in but cannot create a group, this step was skipped.**
3. In **Authentication → URL Configuration**, the Site URL and redirect URLs must include the address you open the app at (for development, `http://localhost:5173`), or confirmation and reset links will not come back to the app.

Do not run the tests or benchmarks against the hosted project. They create and delete users, and the benchmarks refuse to run against anything but localhost.

## Production build

```bash
npm run build
```

```bash
npm start
```

Express then serves the built frontend from `client/dist` together with the API on one port (`PORT`, default 3000).

## Tests

| Command | Needs | What it checks |
| --- | --- | --- |
| `npm test` | Nothing | `repository.js` and `live.js`: the RPC contract, snapshot ordering, reconnect and cleanup |
| `npm run test:browser` | Chromium (`npx playwright install chromium`) | The poll screens in a real browser with a fake data source: two users voting, reconnecting, closing, mobile layout |
| `npm run test:rls` | Local Supabase + `.env.test` | Row level security as an outsider and as a member, voting rules (ties, no votes, vote racing a close), and that Express rejects bad tokens |
| `npm run test:realtime` | Local Supabase + `.env.test` | A real Realtime event reaches a second signed-in user |

Set up `.env.test` once:

```bash
cp .env.test.example .env.test
```

Fill in the publishable key and secret key from `npm run db -- status`. Tests create their own users and groups and delete them afterwards.

The browser tests do not touch Supabase. They prove the screens behave; `test:rls` and `test:realtime` prove the database does.

## Benchmarks

All three run only against local Supabase and write to `benchmarks/results/` (git-ignored; copy results into the report if you need them kept).

| Command | Question it answers |
| --- | --- |
| `npm run bench:rls` | What does row level security cost compared with hand-written membership checks, at 50, 500 and 5,000 groups? |
| `npm run bench:voting` | How long does the vote-total query take with and without `votes_poll_option_idx`, at 1,000, 10,000 and 50,000 votes? |
| `npm run bench:realtime` | How long from a vote until other users see it, with Realtime versus polling, for 1 to 50 watchers? |

Options are documented at the top of each script and in [task5-voting-performance.md](task5-voting-performance.md) and [bingrui-handoff.md](bingrui-handoff.md).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **frontend**: `npm test`, `npm run build`, `npm run test:browser`.
- **supabase**: starts local Supabase (which applies every migration to an empty database), then `npm run test:rls` and `npm run test:realtime`.

A migration that only works on top of someone's hand-edited database will fail the second job. That is the point.

## Troubleshooting

### I can sign in, but creating a group fails

The database you are connected to does not match the code. There are two causes, and both are fixed by applying the latest migrations.

**1. Migrations were never pushed to the hosted project.** The API answers with status 503 and "The database does not match this version of the app", and the Express log shows a line starting `Database schema mismatch`. Check what the hosted database has:

```bash
npx supabase migration list
```

Every row should have a timestamp in both the Local and Remote columns. If Remote is empty for some, follow [Applying migrations to the hosted project](supabase.md#applying-migrations-to-the-hosted-project).

**2. Your account has no profile row.** The API answers with status 409 and "Your account has no profile yet". Every group, membership, poll and vote points at `public.profiles`, and that row is created by a trigger at sign-up. Accounts made before the trigger existed do not have one. The migration `20261124000000_backfill_profiles.sql` creates the missing rows, so pushing migrations fixes this too.

To check either by hand, run this in the dashboard's SQL Editor:

```sql
-- Which migrations has this database run?
select version from supabase_migrations.schema_migrations order by 1;

-- Auth users without a profile (should return no rows).
select u.id, u.email
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);
```

Locally, the fix for both is `npm run db -- db reset`.

### The page says to add `VITE_SUPABASE_URL` …

`client/.env` is missing or still has the placeholder key. Fill it in and restart `npm run dev` (Vite only reads `.env` at startup).

### `/api/health` says `"supabase": "not_configured"` or `"unavailable"`

- `not_configured`: `server/.env` is missing or has the placeholder key.
- `unavailable`: the URL is wrong, or local Supabase is not running (`npm run db -- start`).

### Every API call returns 401 and I get signed out

The browser and Express are pointed at different Supabase projects, so Express cannot verify the token the browser got. Make `client/.env` and `server/.env` match.

### Sign-up says "That username is already taken"

Usernames are unique. Also shown if the profile trigger fails for any other reason; the Auth logs in the dashboard have the real error.

### Sign-up works but I am not signed in

Email confirmation is on in the hosted project. Open the link in the confirmation email, or confirm the user under **Authentication → Users**.

### The poll page says "Reconnecting" and never "Live updates"

Realtime is not delivering database changes. The page still updates every 5 seconds by re-reading. Check that the Realtime migration was applied (`20261118000000`), and in the dashboard under **Database → Publications** that `supabase_realtime` includes `polls`, `options` and `votes`.

### `npm run db -- start` fails

Docker is not running, or ports 54321 to 54324 are in use (often another Supabase project: run `npx supabase stop --all`).

### A test fails with "Set local Supabase credentials"

`.env.test` is missing. See [Tests](#tests).
