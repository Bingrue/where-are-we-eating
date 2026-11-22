# Task 5: voting logic and performance

## Database behavior

- `cast_vote(p_poll_id, p_option_id)` requires an authenticated group member, an open poll, and an option belonging to that poll. A voter can change their choice; the unique `(poll_id, user_id)` constraint keeps one vote per person per poll.
- `close_poll(p_poll_id)` is limited to the poll creator. It stores `closed` and the winning option in one transaction. Closing again returns the saved winner.
- Both write functions lock the poll row first. This serializes votes with closing: a vote that gets the lock first is committed before close calculates the outcome; if close gets it first, the waiting vote sees a closed poll and fails.
- A tie goes to the option suggested earliest (`created_at`), with option UUID as the stable fallback when timestamps match. Closing with no votes saves a null outcome.
- `get_vote_totals(p_poll_id)` returns each restaurant option and its count for a current group member. The client uses it for poll snapshots. Vote table writes are revoked from authenticated clients; updates go through `cast_vote`.
- `votes_poll_option_idx` covers `(poll_id, option_id)` and includes the vote id used by the count, supporting the per-poll aggregate and close-winner query.

## Performance experiment

Start local Supabase, then run `npm run bench:voting`. The benchmark defaults to 1,000, 10,000, and 50,000 votes with ten measured runs per condition (plus warmups). It runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the vote-total query as an authenticated group member, before and after the index, records planning plus execution time, and saves both plans. Each dataset and the temporary index changes run inside a transaction that is rolled back.

To use other scales or more samples, set `VOTE_BENCH_SIZES` to exactly three comma-separated counts and `VOTE_BENCH_RUNS` to 3 to 100. Run only against the local database. The script writes `benchmarks/results/voting-performance.csv`, `.svg`, and plan files; the SVG is generated from the measured medians. Those files are git-ignored, so copy the measured CSV and chart into the report if the project needs versioned results.

The RLS integration suite also exercises voting and closing permissions, a tie, zero-vote closure, retry behavior, and a concurrent vote/close race. Run it with `npm run test:rls` after setting the local Supabase credentials in `.env.test`.
