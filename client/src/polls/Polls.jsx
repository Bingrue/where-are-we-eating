import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import { navigate } from '../router.js';
import { createPollRepository } from './repository.js';
import { watchPoll } from './live.js';

const defaultRepository = createPollRepository(supabase);
const statuses = { connecting: 'Connecting to live updates…', live: 'Live updates',
  reconnecting: 'Reconnecting · checking for updates', offline: 'Offline · results may be out of date' };

export function GroupPolls({ groupId, repository = defaultRepository }) {
  const [polls, setPolls] = useState(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setPolls(null);
    repository.list(groupId).then((data) => { if (active) { setPolls(data); setError(''); } })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [groupId, repository, reload]);
  async function create(event) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true); setError('');
    try {
      const poll = await repository.create(groupId, question.trim());
      navigate(`/polls/${poll.id}`);
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  return <section className="card">
    <h2>Restaurant polls</h2>
    {error && <p className="error" role="alert">{error} <button className="link" onClick={() => setReload((n) => n + 1)}>Retry</button></p>}
    {!polls && !error && <p role="status">Loading polls…</p>}
    {polls?.length === 0 && <p className="muted">No polls yet. Start one to pick your next meal.</p>}
    <ul className="list">{polls?.map((poll) => <li key={poll.id}>
      <a href={`/polls/${poll.id}`} onClick={(event) => { event.preventDefault(); navigate(`/polls/${poll.id}`); }}>{poll.question}</a>
      <span className="badge">{poll.status === 'open' ? 'Open' : 'Closed'}</span>
    </li>)}</ul>
    <form className="stack poll-create" onSubmit={create}>
      <label>Poll question<input value={question} onChange={(event) => setQuestion(event.target.value)} required maxLength={200} placeholder="Where should we eat tonight?" /></label>
      <button disabled={busy || !question.trim()}>{busy ? 'Creating…' : 'Create poll'}</button>
    </form>
  </section>;
}

export function PollPage({ pollId, userId, repository = defaultRepository }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState('connecting');
  const watcher = useRef(null);
  const actionLock = useRef(false);
  useEffect(() => {
    setSnapshot(null); setError(''); setActionError(''); setConfirm(false);
    const stream = watchPoll({ repository, pollId, userId, onData: setSnapshot, onError: setError, onStatus: setStatus });
    watcher.current = stream;
    return () => { stream.stop(); watcher.current = null; };
  }, [repository, pollId, userId]);
  async function act(operation, done) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setActionError('');
    try { await operation(); done?.(); }
    catch (caught) { setActionError(caught.message); }
    finally { await watcher.current?.refresh(); actionLock.current = false; setBusy(false); }
  }
  function suggest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const restaurant_name = String(values.get('restaurant_name')).trim();
    if (!restaurant_name) return;
    void act(() => repository.suggest(pollId, {
      restaurant_name, food_category: String(values.get('food_category')).trim() || null,
      price_range: String(values.get('price_range')) || null,
    }), () => form.reset());
  }
  if (!snapshot) return <section className="card">
    {error ? <><p className="error" role="alert">{error}</p><button onClick={() => watcher.current?.refresh()}>Retry</button></> : <p role="status">Loading poll…</p>}
    <p><button className="link" onClick={() => navigate('/')}>Back to your groups</button></p>
  </section>;
  const open = snapshot.status === 'open';
  const total = snapshot.options.reduce((sum, option) => sum + option.vote_count, 0);
  const winner = snapshot.options.find((option) => option.id === snapshot.saved_outcome_option_id);
  return <>
    <p><button className="link" onClick={() => navigate(`/groups/${snapshot.group_id}`)}>← Back to group</button></p>
    <section className="card">
      <div className="row poll-heading"><span className="badge">{open ? 'Open' : 'Closed'}</span><span className={`live-status ${status}`} role="status">{statuses[status]}</span></div>
      <h2>{snapshot.question}</h2>
      <p className="muted">{open ? 'Suggest a restaurant, then choose your favorite.' : 'Voting has ended.'}</p>
      {error && <p className="error" role="alert">{error} <button className="link" onClick={() => watcher.current?.refresh()}>Retry</button></p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {!open && <div className="notice"><h3>Final result</h3><p>{winner ? winner.restaurant_name : 'No restaurant was selected.'}</p></div>}
      <p aria-live="polite">{total} {total === 1 ? 'vote' : 'votes'} cast{snapshot.my_option_id ? ' · You’ve voted' : ''}</p>
      {snapshot.options.length === 0 && <p className="muted">No restaurants suggested yet.</p>}
      <ul className="list options">{snapshot.options.map((option) => <li key={option.id}>
        <div className="option-content"><h3>{option.restaurant_name}{snapshot.my_option_id === option.id && <span className="badge">Your vote</span>}</h3>
          <p className="muted">{[option.food_category, option.price_range].filter(Boolean).join(' · ') || 'No extra details'}</p>
          <meter min="0" max={total || 1} value={option.vote_count} aria-label={`Vote share for ${option.restaurant_name}`} />
        </div>
        <div className="stack option-actions"><strong>{option.vote_count} {option.vote_count === 1 ? 'vote' : 'votes'}</strong>
          {open && <button className="secondary" disabled={busy || snapshot.my_option_id === option.id || status === 'offline'}
            aria-label={`Vote for ${option.restaurant_name}`} onClick={() => act(() => repository.vote(pollId, option.id))}>
            {snapshot.my_option_id === option.id ? 'Selected' : snapshot.my_option_id ? 'Change vote' : 'Vote'}
          </button>}
        </div>
      </li>)}</ul>
    </section>
    {open && <div className="columns">
      <section className="card"><h3>Suggest a restaurant</h3><form onSubmit={suggest}>
        <fieldset className="stack" disabled={busy || status === 'offline'}>
          <label>Restaurant name<input name="restaurant_name" required maxLength={100} /></label>
          <label>Food category<input name="food_category" maxLength={60} placeholder="Italian, Thai, …" /></label>
          <label>Price range<select name="price_range" defaultValue=""><option value="">Not specified</option>{['$', '$$', '$$$', '$$$$'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <button>Add restaurant</button>
        </fieldset>
      </form></section>
      {snapshot.created_by === userId && <section className="card"><h3>Close poll</h3><p>End voting and save the final result.</p>
        {confirm ? <><p>Ready to close this poll?</p><div className="row"><button disabled={busy || status === 'offline'} onClick={() => act(() => repository.close(pollId), () => setConfirm(false))}>Confirm close</button><button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></div></>
          : <button className="secondary" disabled={busy || status === 'offline'} onClick={() => setConfirm(true)}>Close poll</button>}
      </section>}
    </div>}
  </>;
}
