// Everything the poll screens read from or write to Supabase goes through this object.
// Unlike groups (which go through the Express API), polls talk to Supabase directly
// from the browser with the signed-in user's session, so row level security applies
// and Realtime can push changes. The UI and the tests can swap in a fake repository.

// The query names a table, column or function the database does not have.
const schemaMismatchCodes = new Set([
  '42P01', '42703', '42883', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205',
]);

function toError(error) {
  if (schemaMismatchCodes.has(error.code)) {
    return new Error('Polls are not available yet: the database is missing the latest migrations.');
  }
  if (error.code === 'PGRST116') return new Error('Poll not found.');
  return new Error(error.message);
}

export function createPollRepository(client) {
  function db() {
    if (!client) throw new Error('Please configure Supabase and sign in.');
    return client;
  }

  async function unwrap(query) {
    const { data, error } = await query;
    if (error) throw toError(error);
    return data;
  }

  return {
    list(groupId) {
      return unwrap(db().from('polls')
        .select('id, question, status, created_at')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false }));
    },

    // created_by defaults to auth.uid() in the database.
    create(groupId, question) {
      return unwrap(db().from('polls')
        .insert({ group_id: groupId, question })
        .select('id')
        .single());
    },

    // One consistent snapshot of a poll: its options, each option's vote count and
    // the current user's own vote. The UI never counts votes from Realtime payloads.
    async read(pollId, userId) {
      const [poll, ownVote, totals] = await Promise.all([
        unwrap(db().from('polls')
          .select(`id, group_id, question, created_by, status, saved_outcome_option_id,
            options:options!options_poll_id_fkey(id, restaurant_name, food_category, price_range, created_at)`)
          .eq('id', pollId)
          .single()),
        unwrap(db().from('votes')
          .select('option_id')
          .eq('poll_id', pollId)
          .eq('user_id', userId)
          .maybeSingle()),
        unwrap(db().rpc('get_vote_totals', { p_poll_id: pollId })),
      ]);

      const counts = new Map(totals.map(({ option_id, vote_count }) => [option_id, Number(vote_count)]));
      const options = poll.options
        .map((option) => ({ ...option, vote_count: counts.get(option.id) ?? 0 }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return { ...poll, options, my_option_id: ownVote?.option_id ?? null };
    },

    suggest(pollId, values) {
      return unwrap(db().from('options').insert({ poll_id: pollId, ...values }));
    },

    // Votes and closing go through database functions that lock the poll row, so a
    // vote can never be counted after the poll closes. Clients cannot write votes directly.
    async vote(pollId, optionId) {
      await unwrap(db().rpc('cast_vote', { p_poll_id: pollId, p_option_id: optionId }));
    },

    async close(pollId) {
      await unwrap(db().rpc('close_poll', { p_poll_id: pollId }));
    },

    // Subscribe to new and changed polls in one group. `changed` is called on every
    // event (the caller re-reads the list). Returns a function that unsubscribes.
    observeGroup(groupId, changed) {
      const channel = db().channel(`group-polls:${groupId}:${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'polls', filter: `group_id=eq.${groupId}` }, changed)
        .subscribe();
      return () => { void client.removeChannel(channel); };
    },

    // Subscribe to Postgres Changes for one poll. `changed` is called whenever something
    // may have changed (the caller re-reads the snapshot); `status` reports 'live' or
    // 'reconnecting'. Returns a function that removes the subscription.
    observe(pollId, changed, status) {
      const channel = db().channel(`poll:${pollId}:${crypto.randomUUID()}`);
      const bindings = [
        ['polls', 'UPDATE'],
        ['options', 'INSERT'], ['options', 'UPDATE'],
        ['votes', 'INSERT'], ['votes', 'UPDATE'],
      ];
      // No DELETE bindings: Supabase cannot filter delete events by column, so the
      // periodic snapshot in live.js reconciles deletes instead.
      for (const [table, event] of bindings) {
        const filter = `${table === 'polls' ? 'id' : 'poll_id'}=eq.${pollId}`;
        channel.on('postgres_changes', { event, schema: 'public', table, filter }, changed);
      }

      // A joined socket alone doesn't prove that Postgres Changes is working: wait for
      // the server to acknowledge the bindings (one message covers all of them).
      channel.on('system', '*', (message) => {
        if (message.extension !== 'postgres_changes') return;
        if (message.status === 'ok') {
          status('live');
          changed();
        } else {
          status('reconnecting');
        }
      });
      channel.subscribe((state) => {
        if (state !== 'SUBSCRIBED') status('reconnecting');
      });

      return () => { void client.removeChannel(channel); };
    },
  };
}
