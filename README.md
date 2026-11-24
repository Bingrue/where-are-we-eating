# Where Are We Eating?

A group restaurant polling app. Friends make a group, share an invite link, start a poll, suggest restaurants and vote; results update live for everyone, and closing the poll saves the winner.

- **Frontend:** React 19 + Vite (`client/`)
- **API:** Express 5 (`server/`), used for profiles and groups
- **Backend:** Supabase: Postgres, Auth, row level security and Realtime (`supabase/`)

## Documentation

| Read this | To learn |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit together, what each file does, and how a request flows |
| [docs/supabase.md](docs/supabase.md) | How we use Supabase: keys, sign-in, row level security, database functions, Realtime, migrations |
| [docs/database.md](docs/database.md) | Every table, constraint, policy and function |
| [docs/development.md](docs/development.md) | Setup, everyday commands, tests, benchmarks, CI and **troubleshooting** |

Task reports from the project: [task 5 voting and performance](docs/task5-voting-performance.md), [tasks 1 and 6 poll screens and Realtime](docs/bingrui-handoff.md), and the original [project proposal](docs/project-proposal.pdf).

## Quick start

You need Node.js 24 (see `.nvmrc`) and Docker (for local Supabase).

```bash
npm ci
```

```bash
npm run db -- start
```

`db start` downloads and runs Supabase locally and applies every migration. When it finishes it prints an API URL and keys (run `npm run db -- status` to see them again). Copy the example environment files and paste in the **API URL** and **publishable key**:

```bash
cp client/.env.example client/.env
```

```bash
cp server/.env.example server/.env
```

Then start the app:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend runs on port 5173 and proxies `/api` to Express on port 3000. [http://localhost:3000/api/health](http://localhost:3000/api/health) shows whether Express can reach Supabase.

To use the shared hosted Supabase project instead of a local one, see [docs/development.md](docs/development.md#using-the-hosted-project).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run Express and Vite together with reload |
| `npm run build` / `npm start` | Build the frontend, then serve it and the API from Express |
| `npm run db -- <args>` | The Supabase CLI (`start`, `stop`, `status`, `db reset`, `migration new`, …) |
| `npm test` | Unit tests for the poll data layer (no database) |
| `npm run test:browser` | Playwright tests of the poll screens against a fake data source |
| `npm run test:rls` | Security, voting and API-token tests against local Supabase |
| `npm run test:realtime` | Realtime integration test against local Supabase |
| `npm run bench:rls`, `bench:voting`, `bench:realtime` | The three performance experiments |

## Something not working?

Start with [Troubleshooting](docs/development.md#troubleshooting). The most common problem, "I can sign in but cannot create a group", means the database you are connected to is missing migrations.
