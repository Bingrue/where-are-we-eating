# Where Are We Eating?

A starter project for a group restaurant polling app. It includes a React frontend, an Express API, and configuration for running Supabase locally.

## Run the frontend and API

Use Node.js 24 and run these commands from the repository root:

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The page should display **API connected**. You can also open [the health endpoint](http://localhost:3000/api/health) directly and check that it returns `{"status":"ok"}`. The health check verifies that Express is running.

## Start local Supabase

Start Docker, then run:

```bash
npm run db -- start
npm run db -- status
cp client/.env.example client/.env
cp server/.env.example server/.env
```

Copy the local API URL and publishable key from the status output into both environment files. Open [Supabase Studio](http://127.0.0.1:54323) to inspect the local database. Run `npm run db -- stop` when you're done.

The next steps are to connect the app to Supabase Auth, add the database schema, and build the polling flow.
