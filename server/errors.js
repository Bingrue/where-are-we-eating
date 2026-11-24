// Turn a Supabase (PostgREST / Postgres) error into an HTTP status and a message
// that is safe to show to the user.
const statusByCode = {
  '42501': 403, // insufficient privilege, including "new row violates row-level security policy"
  P0002: 404, // raised by join_group() for an unknown invite code
  PGRST116: 404, // .single() found no row, e.g. because RLS hides it
  '23505': 409, // unique violation, e.g. username taken
  '23503': 409, // foreign key violation
  '23514': 400, // check constraint
  '22P02': 400, // invalid input syntax, e.g. a malformed uuid
};

// The query names a table, column or function the database does not have: the
// project is missing migrations (or has newer ones than this code expects).
const schemaMismatchCodes = new Set([
  '42P01', // undefined table
  '42703', // undefined column
  '42883', // undefined function
  'PGRST200', // no relationship between the embedded tables
  'PGRST202', // function not in PostgREST's schema cache
  'PGRST204', // column not in PostgREST's schema cache
  'PGRST205', // table not in PostgREST's schema cache
]);

export const schemaMismatchMessage =
  'The database does not match this version of the app. Apply the latest migrations '
  + '(see docs/development.md, "Troubleshooting"), then try again.';

function messageFor(error, status) {
  switch (error?.code) {
    case '42501':
      // Messages we raise ourselves are written for users; Postgres' own are not.
      return error.message?.includes('row-level security') || error.message?.includes('permission denied')
        ? 'You are not allowed to do that.'
        : error.message;
    case 'P0002':
      return error.message;
    case 'PGRST116':
      return 'Not found.';
    case '23505':
      return 'That value is already taken.';
    case '23503':
      // Every user-owned row points at public.profiles, so for a signed-in user this
      // almost always means their own profile row is missing.
      return `${error.message} ${error.details}`.includes('profiles')
        ? 'Your account has no profile yet. Apply the latest database migrations '
          + '(see docs/development.md, "Troubleshooting"), then try again.'
        : 'That refers to something that no longer exists.';
    default:
      return status === 400 ? 'Check the values you entered.' : 'Something went wrong. Try again.';
  }
}

export function sendSupabaseError(res, error) {
  if (schemaMismatchCodes.has(error?.code)) {
    console.error('Database schema mismatch (are all migrations applied?):', error);
    return res.status(503).json({ error: schemaMismatchMessage, code: error.code });
  }

  const status = statusByCode[error?.code] ?? 500;
  if (status === 500) console.error('Supabase error:', error);
  return res.status(status).json({ error: messageFor(error, status), code: error?.code });
}
