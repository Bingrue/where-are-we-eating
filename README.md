# Where Are We Eating?

A group restaurant polling app with a React frontend, an Express API, and Supabase connectivity.

## Run the app

Use Node.js 24. From the repository root, run:

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend runs on port 5173 and the API runs on port 3000. Check [http://localhost:3000/api/health](http://localhost:3000/api/health) to see the API and Supabase connection status.

## Connect to Supabase

The API reads the Supabase project URL and publishable key from `server/.env`. Create that file with the credentials for your Supabase project:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Get these values from your Supabase project's **Connect** dialog or its API settings. Keep the key in `.env`; do not commit credentials. Restart the dev server after changing the file. The API health endpoint checks Supabase Auth and reports `connected`, `unavailable`, or `not_configured`.

Supabase is optional for starting the frontend and API. Without credentials, the app still runs and reports that Supabase is not configured. The current integration checks connectivity; it does not yet read or write poll data.

## Use local Supabase (optional)

To run a local Supabase stack, install and start Docker, then run from the repository root:

```bash
npm run db -- start
npm run db -- status
```

Use the local API URL and publishable key shown by `status` in `server/.env`. Local Supabase Studio is available at [http://127.0.0.1:54323](http://127.0.0.1:54323). Stop the local stack when finished:

```bash
npm run db -- stop
```
