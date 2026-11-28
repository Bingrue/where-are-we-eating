# How we use Supabase

Supabase is a hosted Postgres database with services built around it. We use four of them:

| Service | What it is | What we use it for |
| --- | --- | --- |
| **Postgres** | The database | Tables, constraints, triggers, functions, row level security |
| **Auth** | User accounts and sessions | Email + password sign-up and sign-in, password reset, access tokens |
| **Data API** (PostgREST) | An HTTP API generated from the database | Every read and write: `supabase.from('table')...` and `supabase.rpc('function')` |
| **Realtime** | Database changes pushed over a WebSocket | Live poll updates |

We do not use Storage, Edge Functions or the GraphQL API.

## Projects: local and hosted

- **Local Supabase** runs on your machine in Docker (`npm run db -- start`). It is rebuilt from `supabase/migrations/`, so it is always exactly what the repository says. Tests and benchmarks run only against local.
- **The hosted project** is the shared database on supabase.com. It only changes when someone pushes migrations to it (`npx supabase db push`).

Which one the app uses depends only on the URL and key in `client/.env` and `server/.env`.

## Keys

| Key | Where it goes | What it can do |
| --- | --- | --- |
| **Publishable key** (`sb_publishable_…`; older projects call it the anon key) | `client/.env`, `server/.env`, `.env.test` | Identifies the project. On its own it can do nothing: the `anon` role has no table privileges. With a user's access token it can do what that user is allowed to do. Safe to ship to the browser. |
| **Secret key** (`sb_secret_…`; older projects call it the service role key) | `.env.test` only, and only for **local** Supabase | Bypasses row level security completely. The tests use it to create and delete test users. The app never uses it. |

Never put the secret key in `client/.env` or `server/.env`, and never commit any `.env` file (they are git-ignored).

## Sign-in (Supabase Auth)

1. **Sign up.** `AuthScreen.jsx` calls `supabase.auth.signUp()` with the email, password and, as metadata, a username and display name.
2. **Profile row.** Auth stores the user in its own table, `auth.users`. Our trigger `on_auth_user_created` copies the id, username and display name into `public.profiles`, the table the rest of the schema references.
3. **Session.** Auth returns an access token (a JWT that expires after an hour) and a refresh token. supabase-js keeps them in `localStorage` and refreshes the access token automatically.
4. **React.** `session.jsx` listens to `supabase.auth.onAuthStateChange` and puts the session in context. `main.jsx` shows the sign-in screen when there is none.
5. **Password reset.** `resetPasswordForEmail()` emails a link to `/reset-password`; opening it fires a `PASSWORD_RECOVERY` event and the app asks for a new password.

If email confirmation is turned on in the project (it is off locally, see `supabase/config.toml`), sign-up returns no session until the user opens the link in the email.

### How Express knows who you are

Express does not have its own login. `client/src/api.js` sends the Supabase access token with every request, and `server/auth.js`:

1. Verifies the token with `supabase.auth.getClaims(token)`. This checks the signature and expiry, either locally against the project's public signing keys or by asking Supabase Auth, depending on how the project signs tokens.
2. Rejects anything missing, malformed, expired or forged with 401.
3. Creates `req.supabase`, a Supabase client that sends the same token on every query.

Because of step 3, the database sees the request as coming from that user. In SQL, `auth.uid()` returns their id.

## Row level security (RLS)

RLS is a Postgres feature: each table has policies, and every query is silently filtered by them. A policy is a condition such as "you can read a poll if you are a member of its group". With RLS, a query for a group you are not in does not fail with an error; it returns no rows, as if the group did not exist.

Two layers must both allow an action:

1. **Grants** decide which commands and columns a role can use at all. For example `authenticated` users can insert only the `name` column of `groups`, so a client cannot set `invite_code` or `created_at`.
2. **Policies** decide which rows.

Our rules in plain words:

| Table | Read | Write |
| --- | --- | --- |
| `profiles` | Yourself and people who share a group with you | Update your own username and display name |
| `groups` | Groups you belong to | Anyone signed in can create one (as themselves). Admins rename and delete |
| `group_members` | The roster of your groups | No direct inserts: only the creator trigger and `join_group()`. You can leave; admins can remove members |
| `polls` | Polls in your groups | Members create. Creator or a group admin deletes. No direct updates: closing goes through `close_poll()` |
| `options` | Options of polls in your groups | Members add options while the poll is open |
| `votes` | Votes in polls in your groups | No direct writes at all: only `cast_vote()` |

Signed-out requests (the `anon` role) can do nothing.

The policies call small helper functions in the `private` schema (`my_group_ids()`, `my_poll_ids()`, `my_peer_ids()`, `is_group_admin()`, `is_open_poll_in_my_group()`). The Data API does not expose that schema, so they cannot be called over HTTP. They exist so a policy on `group_members` can ask "is this user a member?" without recursing into itself, and so Postgres evaluates the membership list once per query instead of once per row.

The full policy list is in [database.md](database.md). `tests/rls-attacks.test.js` proves the rules by attacking them as an outsider and as an ordinary member.

## Database functions (RPC)

Some actions are too sensitive or too multi-step for a plain insert, so they are Postgres functions, called with `supabase.rpc('name', { args })`:

| Function | Called from | What it does |
| --- | --- | --- |
| `join_group(p_invite_code)` | Express `POST /api/groups/join` | Finds the group by invite code and adds you as a member. Needed because a non-member cannot see the group row at all |
| `rotate_group_invite(p_group_id)` | Express `POST /api/groups/:id/invite` | Admin only. Replaces the invite code |
| `cast_vote(p_poll_id, p_option_id)` | Browser, `repository.vote()` | Casts or changes your vote. Locks the poll row first |
| `close_poll(p_poll_id)` | Browser, `repository.close()` | Creator only. Picks the winner, saves it and marks the poll closed. Locks the poll row first |
| `get_vote_totals(p_poll_id)` | Browser, `repository.read()` | Vote count per option, for members |

`cast_vote` and `close_poll` both lock the poll row before doing anything. That makes them take turns: a vote that gets the lock first is counted; a vote that arrives after the close sees a closed poll and is rejected. Without the lock, a vote could slip in between "count the votes" and "mark as closed".

Most of these are `security definer`: they run with the privileges of the function's owner, not the caller, which lets them do things the caller has no grant for (like inserting into `group_members`). That is why each one checks `auth.uid()` and membership itself, and sets `search_path = ''` so it cannot be tricked into using a look-alike table.

## Realtime

`supabase/migrations/20261118000000_poll_realtime.sql` adds `polls`, `options` and `votes` to the `supabase_realtime` publication, which tells Postgres to stream changes on those tables.

In the browser, `repository.observe(pollId, ...)` opens a channel and subscribes to "Postgres Changes" filtered to one poll (`poll_id=eq.<id>`). Realtime applies the same RLS read policies before sending an event, so you only receive changes to rows you could have selected.

`live.js` wraps this so the page stays correct even when the connection is not:

- It shows "Live updates" only after the server confirms the subscription.
- Every event triggers a re-read of the whole poll rather than patching the screen from the event.
- It re-reads when the connection comes back, when the tab becomes visible, every 5 seconds while not live, and every 10 seconds regardless (so a missed Realtime event shows up within 10 seconds).

## Migrations

The database schema is code. Each file in `supabase/migrations/` is a SQL script named `<timestamp>_<name>.sql`, and they run in timestamp order. Supabase records which ones have run in the table `supabase_migrations.schema_migrations`.

| Migration | What it adds |
| --- | --- |
| `20261114000000_core_schema.sql` | The six tables, their constraints, and the profile-on-sign-up trigger |
| `20261116000000_groups_and_rls.sql` | Invite codes, `join_group()`, `rotate_group_invite()`, grants and all RLS policies |
| `20261118000000_poll_realtime.sql` | Publishes `polls`, `options`, `votes` to Realtime |
| `20261119000000_voting_functions_and_indexes.sql` | `cast_vote()`, `close_poll()`, `get_vote_totals()`, the votes index; revokes direct vote writes |
| `20261124000000_backfill_profiles.sql` | Gives every existing Auth user a profile row and re-asserts the sign-up trigger |

### Changing the database

1. Create a new file. Never edit a migration that has already been pushed: databases that ran the old version will not run it again.

   ```bash
   npm run db -- migration new describe_your_change
   ```

2. Write the SQL in the new file under `supabase/migrations/`.
3. Rebuild your local database from scratch to prove the whole chain still works:

   ```bash
   npm run db -- db reset
   ```

4. Run the tests (`npm run test:rls`, `npm run test:realtime`).
5. Commit the migration with the code that needs it.
6. After it is merged, push it to the hosted project (next section) and tell the team.

Things to remember when writing one:

- A new table needs `alter table ... enable row level security`, grants and policies, or nobody can read it (or, worse, everyone can).
- A new function needs `revoke all ... from public, anon` and `grant execute ... to authenticated`.
- If the frontend should get live updates for a new table, add it to the `supabase_realtime` publication.

### Applying migrations to the hosted project

One time per machine, log in and link the repository to the project (the project ref is the id in the dashboard URL):

```bash
npx supabase login
```

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

See which migrations the hosted database has and which it is missing:

```bash
npx supabase migration list
```

The hosted project was created by hand before migrations existed, so it already contains the core schema. If the list shows `20261114000000` as not applied remotely, mark it as applied instead of running it (this only needs to be done once, by one person):

```bash
npx supabase migration repair --status applied 20261114000000
```

Then apply everything that is missing:

```bash
npx supabase db push
```

## The Supabase dashboard

Useful places, in the hosted dashboard or local Studio ([http://127.0.0.1:54323](http://127.0.0.1:54323)):

- **Table Editor**: browse and edit rows. It runs as the database owner, so it sees everything regardless of RLS.
- **SQL Editor**: run SQL. Good for the checks in [development.md](development.md#troubleshooting).
- **Authentication → Users**: see, confirm or delete accounts.
- **Authentication → URL Configuration**: the Site URL and allowed redirect URLs. Confirmation and password-reset links only work for URLs listed here.
- **Database → Policies**: every RLS policy per table.
- **Project Settings → API Keys** (or the **Connect** button): the project URL and keys.

Locally, emails that Auth "sends" (confirmations, password resets) are caught at [http://127.0.0.1:54324](http://127.0.0.1:54324).
