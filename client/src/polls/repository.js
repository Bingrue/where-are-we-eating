// Task 6 adapter. Uses the task 5 RPCs for vote writes and vote totals.
export function createPollRepository(client) {
  function db() {
    if (!client) throw new Error('Please configure Supabase and sign in.');
    return client;
  }
  async function unwrap(query) {
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
  }
  async function command(name, args) {
    const { error } = await db().rpc(name, args);
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        throw new Error('Voting is not available yet. Please try again later.');
      }
      throw new Error(error.message);
    }
  }
  return {
    list: (groupId) => unwrap(db().from('polls').select('id, question, status, created_at')
      .eq('group_id', groupId).order('created_at', { ascending: false })),
    create: (groupId, question) => unwrap(db().from('polls').insert({ group_id: groupId, question })
      .select('id').single()),
    async read(pollId, userId) {
      const [poll, own, totals] = await Promise.all([
        unwrap(db().from('polls').select(`id, group_id, question, created_by, status, saved_outcome_option_id,
          options:options!options_poll_id_fkey(id, restaurant_name, food_category, price_range, created_at)`)
          .eq('id', pollId).single()),
        unwrap(db().from('votes').select('option_id').eq('poll_id', pollId).eq('user_id', userId).maybeSingle()),
        unwrap(db().rpc('get_vote_totals', { p_poll_id: pollId })),
      ]);
      const counts = new Map(totals.map(({ option_id, vote_count }) => [option_id, Number(vote_count)]));
      const options = poll.options.map((option) => ({ ...option, vote_count: counts.get(option.id) ?? 0 }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return { ...poll, options, my_option_id: own?.option_id ?? null };
    },
    suggest: (pollId, values) => unwrap(db().from('options').insert({ poll_id: pollId, ...values })),
    vote: (pollId, optionId) => command('cast_vote', { p_poll_id: pollId, p_option_id: optionId }),
    close: (pollId) => command('close_poll', { p_poll_id: pollId }),
    observe(pollId, changed, status) {
      const channel = db().channel(`poll:${pollId}:${crypto.randomUUID()}`);
      for (const table of ['polls', 'options', 'votes']) {
        for (const event of (table === 'polls' ? ['UPDATE'] : ['INSERT', 'UPDATE'])) {
          channel.on('postgres_changes', {
            event, schema: 'public', table, filter: `${table === 'polls' ? 'id' : 'poll_id'}=eq.${pollId}`,
          }, changed);
        }
      }
      // A joined socket alone doesn't prove that Postgres Changes is working.
      channel.on('system', '*', (message) => {
        if (message.extension !== 'postgres_changes') return;
        if (message.status === 'ok') {
          // Supabase acknowledges all bindings together for this channel.
          status('live');
          changed();
        } else status('reconnecting');
      });
      channel.subscribe((value) => {
        if (value !== 'SUBSCRIBED') {
          status('reconnecting');
        }
      });
      return () => { void client.removeChannel(channel); };
    },
  };
}
