import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { command, supabase, unwrap } from './supabase.js';
import { Notice, useTask } from './ui.jsx';

function usePollSnapshot(pollId) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const refresh = useRef(() => {});

  useEffect(() => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pollId)) {
      setError('Poll not found.');
      return;
    }
    let active = true;
    let request = 0;
    let connected = false;
    let timer;
    async function load() {
      const sequence = ++request;
      try {
        const next = unwrap(await supabase.rpc('dining_poll_snapshot', { p_poll: pollId }));
        if (active && sequence === request) {
          setSnapshot((current) => !current || current.poll.revision <= next.poll.revision ? next : current);
          setError('');
        }
      } catch (failure) {
        if (active && sequence === request) setError(failure.message);
      }
    }

    refresh.current = load;
    void load();
    const channel = supabase.channel('poll:' + pollId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'polls', filter: 'id=eq.' + pollId,
      }, () => {
        clearTimeout(timer);
        timer = setTimeout(load, 80);
      })
      .on('system', '*', ({ extension, status }) => {
        if (!active || extension !== 'postgres_changes') return;
        connected = status === 'ok';
        setLive(connected);
        if (connected) void load();
      });
    supabase.realtime.setAuth().then(() => {
      if (!active) return;
      channel.subscribe((status) => {
        if (active && status !== 'SUBSCRIBED') {
          connected = false;
          setLive(false);
        }
      });
    }).catch(() => { /* Snapshot polling continues while the channel is unavailable. */ });
    let lastRecovery = Date.now();
    const fallback = setInterval(() => {
      if (document.visibilityState === 'visible' && (!connected || Date.now() - lastRecovery >= 30_000)) {
        lastRecovery = Date.now();
        void load();
      }
    }, 5_000);
    function onVisible() {
      if (document.visibilityState === 'visible') void load();
    }
    window.addEventListener('online', load);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener('online', load);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [pollId]);

  return { snapshot, error, live, refresh: () => refresh.current() };
}

export function Poll({ userId }) {
  const { pollId } = useParams();
  return <PollView key={pollId} pollId={pollId} userId={userId} />;
}

function PollView({ pollId, userId }) {
  const { snapshot, error, live, refresh } = usePollSnapshot(pollId);
  const [confirm, setConfirm] = useState(false);
  const task = useTask();

  function mutate(path, body, onSuccess) {
    task.run(async () => {
      try {
        await command('/polls/' + pollId + path, body);
        onSuccess?.();
      } finally {
        await refresh();
      }
    });
  }

  function suggest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    mutate('/options', {
      name: values.get('name'),
      category: values.get('category'),
      priceLevel: Number(values.get('priceLevel')),
    }, () => form.reset());
  }

  if (!snapshot) return <>
    <Link to="/" className="back-link">← Your groups</Link>
    {error ? <><Notice error={error} /><button className="button secondary" onClick={refresh}>Retry</button></>
      : <p role="status">Loading poll…</p>}
  </>;

  const { poll, options, outcome, my_option_id: myVote } = snapshot;
  const open = poll.status === 'open';
  const total = outcome?.total_votes ?? options.reduce((sum, option) => sum + option.vote_count, 0);
  const winner = options.find((option) => option.id === poll.winner_option_id);

  return <>
    <Link className="back-link" to={'/groups/' + poll.group_id}>← Back to group</Link>
    <section className="hero compact poll-hero">
      <div className="hero-meta">
        <p className="eyebrow">Dinner poll</p>
        <span className={'badge ' + poll.status}>{open ? 'Open' : 'Closed'}</span>
      </div>
      <h1>{poll.question}</h1>
      <p>{open ? 'Suggest a spot or cast one vote for your favorite.' : 'Voting has ended and the results are saved.'}</p>
    </section>
    <Notice error={error} />
    <Notice error={task.error} />
    {!open && <section className="card outcome">
      <p className="eyebrow">Final result</p>
      <h2>{winner ? winner.name : 'No winner'}</h2>
      <p>{outcome.tied_leaders > 1
        ? 'The top restaurants tied. The earliest suggestion wins the tie.'
        : winner ? 'This restaurant received the most votes.' : 'This poll closed without any votes.'}</p>
    </section>}
    <section className="card">
      <div className="section-heading">
        <h2>Restaurants</h2>
        {open && <span className={'live-status' + (live ? ' active' : '')}>
          {live ? 'Live updates' : 'Checking for updates'}
        </span>}
      </div>
      <p aria-live="polite">{total} {total === 1 ? 'vote' : 'votes'} cast{myVote ? ' · You’ve voted' : ''}</p>
      {options.length === 0 && <p>No restaurants suggested yet.</p>}
      <ul className="options">
        {options.map((option) => <li className="option" key={option.id}>
          <div className="option-top">
            <div>
              <h3>{option.name} {option.id === myVote && <span className="badge open">Your vote</span>}</h3>
              <p>{option.category} · <span aria-label={'Price level ' + option.price_level + ' of 4'}>
                {'$'.repeat(option.price_level)}
              </span></p>
            </div>
            <strong>{option.vote_count} {option.vote_count === 1 ? 'vote' : 'votes'}</strong>
          </div>
          <meter min="0" max={total || 1} value={option.vote_count} aria-label={'Vote share for ' + option.name} />
          {open && !myVote && <button className="button secondary" disabled={task.busy}
            aria-label={'Vote for ' + option.name} onClick={() => mutate('/votes', { optionId: option.id })}>Vote</button>}
        </li>)}
      </ul>
    </section>
    {open && <div className="two-columns">
      <section className="card">
        <h2>Suggest a restaurant</h2>
        <form onSubmit={suggest}>
          <fieldset className="stack" disabled={task.busy}>
            <label>Restaurant name<input name="name" required maxLength={100} /></label>
            <label>Food category<input name="category" required maxLength={60} placeholder="Italian, Thai, or another cuisine" /></label>
            <label>Price range<select name="priceLevel" defaultValue="2">
              <option value="1">$ · Budget</option><option value="2">$$ · Moderate</option>
              <option value="3">$$$ · Upscale</option><option value="4">$$$$ · Special occasion</option>
            </select></label>
            <button className="button primary">Add restaurant</button>
          </fieldset>
        </form>
      </section>
      {poll.created_by === userId && <section className="card">
        <h2>Close the poll</h2>
        <p>Closing ends voting and saves the final result.</p>
        {confirm ? <>
          <p>Ready to make it final?</p>
          <div className="actions">
            <button className="button primary" disabled={task.busy}
              onClick={() => mutate('/close', {}, () => setConfirm(false))}>Confirm close</button>
            <button className="button quiet" disabled={task.busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </> : <button className="button secondary" disabled={task.busy} onClick={() => setConfirm(true)}>Close poll</button>}
      </section>}
    </div>}
  </>;
}
