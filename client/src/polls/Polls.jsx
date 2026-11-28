import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../router.js';
import { supabase } from '../supabase.js';
import { useLiveRefresh } from '../useLiveRefresh.js';
import { watchPoll } from './live.js';
import { createPollRepository } from './repository.js';

const defaultRepository = createPollRepository(supabase);

const statusLabels = {
  connecting: 'Connecting to live updates…',
  live: 'Live updates',
  reconnecting: 'Reconnecting · checking for updates',
  offline: 'Offline · results may be out of date',
};

const priceRanges = ['$', '$$', '$$$', '$$$$'];

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

// The list of polls in a group, with a form to start a new one.
export function GroupPolls({ groupId, repository = defaultRepository }) {
  const [polls, setPolls] = useState(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);

  // Re-read the list. Used on load, on Realtime events and in the background.
  const reload = useCallback(async () => {
    try {
      const data = await repository.list(groupId);
      if (!active.current) return;
      setPolls(data);
      setError('');
    } catch (caught) {
      if (active.current) setError(caught.message);
    }
  }, [groupId, repository]);

  useEffect(() => {
    active.current = true;
    setPolls(null);
    void reload();
    let stop = () => {};
    try {
      stop = repository.observeGroup?.(groupId, () => void reload()) ?? stop;
    } catch {
      // Realtime unavailable: the background refresh below still picks up new polls.
    }
    return () => {
      active.current = false;
      stop();
    };
  }, [groupId, repository, reload]);

  useLiveRefresh(reload);

  async function create(event) {
    event.preventDefault();
    if (busy || !question.trim()) return;
    setBusy(true);
    setError('');
    try {
      const poll = await repository.create(groupId, question.trim());
      navigate(`/polls/${poll.id}`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="table">
      <form className="poll-create" onSubmit={create}>
        <label>
          Poll question
          <span className="inline-form">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              required
              maxLength={200}
              placeholder="Where should we eat tonight?"
            />
            <button type="submit" disabled={busy || !question.trim()}>{busy ? 'Creating…' : 'Create poll'}</button>
          </span>
        </label>
      </form>

      {error && (
        <p className="error pad" role="alert">
          {error}{' '}
          <button type="button" className="link" onClick={() => void reload()}>Retry</button>
        </p>
      )}
      {!polls && !error && <p className="muted pad" role="status">Loading polls…</p>}
      {polls?.length === 0 && <p className="empty">No polls yet. Ask the group a question above to start one.</p>}

      {polls?.length > 0 && (
        <ul className="rows">
          {polls.map((poll) => (
            <li key={poll.id}>
              <a
                className="row-link"
                href={`/polls/${poll.id}`}
                onClick={(event) => { event.preventDefault(); navigate(`/polls/${poll.id}`); }}
              >
                <span className="row-main row-title">{poll.question}</span>
                <span className={`chip ${poll.status === 'open' ? 'open' : ''}`}>
                  {poll.status === 'open' ? 'Voting open' : 'Closed'}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// One poll: live results, voting, suggesting restaurants and (for its creator) closing.
export function PollPage({ pollId, userId, repository = defaultRepository }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [status, setStatus] = useState('connecting');
  const watcher = useRef(null);
  const actionLock = useRef(false);

  useEffect(() => {
    setSnapshot(null);
    setError('');
    setActionError('');
    setConfirmingClose(false);
    const stream = watchPoll({
      repository, pollId, userId, onData: setSnapshot, onError: setError, onStatus: setStatus,
    });
    watcher.current = stream;
    return () => {
      stream.stop();
      watcher.current = null;
    };
  }, [repository, pollId, userId]);

  // Run one write at a time, then re-read the poll whether it worked or not.
  async function act(operation, onSuccess) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setActionError('');
    try {
      await operation();
      onSuccess?.();
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      await watcher.current?.refresh();
      actionLock.current = false;
      setBusy(false);
    }
  }

  function suggest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const restaurantName = String(values.get('restaurant_name')).trim();
    if (!restaurantName) return;
    void act(() => repository.suggest(pollId, {
      restaurant_name: restaurantName,
      food_category: String(values.get('food_category')).trim() || null,
      price_range: String(values.get('price_range')) || null,
    }), () => form.reset());
  }

  if (!snapshot) {
    return (
      <section className="table pad">
        {error ? (
          <>
            <p className="error" role="alert">{error}</p>
            <button type="button" onClick={() => watcher.current?.refresh()}>Retry</button>
          </>
        ) : (
          <p role="status">Loading poll…</p>
        )}
        <p><button type="button" className="link" onClick={() => navigate('/')}>Back to your groups</button></p>
      </section>
    );
  }

  const open = snapshot.status === 'open';
  const offline = status === 'offline';
  const total = snapshot.options.reduce((sum, option) => sum + option.vote_count, 0);
  const winner = snapshot.options.find((option) => option.id === snapshot.saved_outcome_option_id);

  return (
    <>
      <a
        className="back"
        href={`/groups/${snapshot.group_id}`}
        onClick={(event) => { event.preventDefault(); navigate(`/groups/${snapshot.group_id}`); }}
      >
        ← Back to group
      </a>

      <section className="page-intro">
        <div className="row poll-heading">
          <span className={`chip ${open ? 'open' : ''}`}>{open ? 'Voting open' : 'Closed'}</span>
          <span className={`live-status ${status}`} role="status">{statusLabels[status]}</span>
        </div>
        <h2 className="display">{snapshot.question}</h2>
        <p className="muted">{open ? 'Suggest a restaurant, then vote for the one you want.' : 'Voting has ended.'}</p>
      </section>

      <section className="table">

        {!open && (
          <div className="notice">
            <h3>Final result</h3>
            <p className="display winner">{winner ? winner.restaurant_name : 'No restaurant was selected.'}</p>
          </div>
        )}

        <div className="tally-head">
          <p aria-live="polite">
            {plural(total, 'vote')} cast{snapshot.my_option_id ? ' · You’ve voted' : ''}
          </p>
        </div>

        {error && (
          <p className="error pad" role="alert">
            {error}{' '}
            <button type="button" className="link" onClick={() => watcher.current?.refresh()}>Retry</button>
          </p>
        )}
        {actionError && <p className="error pad" role="alert">{actionError}</p>}

        {snapshot.options.length === 0 && (
          <p className="empty">No restaurants yet. Add the first one below.</p>
        )}

        <ul className="options">
          {snapshot.options.map((option) => {
            const mine = snapshot.my_option_id === option.id;
            const leading = !open && option.id === snapshot.saved_outcome_option_id;
            const share = total ? option.vote_count / total : 0;
            return (
              <li
                key={option.id}
                className={`option${mine ? ' mine' : ''}${leading ? ' winner' : ''}`}
                style={{ '--share': share }}
              >
                <span className="bar" aria-hidden="true" />
                <div className="option-content">
                  <h3>{option.restaurant_name}</h3>
                  <p className="tags">
                    {option.food_category && <span className="tag">{option.food_category}</span>}
                    {option.price_range && <span className="tag">{option.price_range}</span>}
                    {mine && <span className="tag yours">Your vote</span>}
                  </p>
                </div>
                <div className="option-actions">
                  <strong className="count">{plural(option.vote_count, 'vote')}</strong>
                  {open && (
                    <button
                      type="button"
                      className={mine ? 'selected' : 'secondary'}
                      disabled={busy || mine || offline}
                      aria-label={`Vote for ${option.restaurant_name}`}
                      onClick={() => act(() => repository.vote(pollId, option.id))}
                    >
                      {mine ? 'Selected' : snapshot.my_option_id ? 'Change vote' : 'Vote'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {open && (
        <div className="columns">
          <section className="panel">
            <h3>Suggest a restaurant</h3>
            <form onSubmit={suggest}>
              <fieldset className="stack" disabled={busy || offline}>
                <label>
                  Restaurant name
                  <input name="restaurant_name" required maxLength={100} />
                </label>
                <label>
                  Food category
                  <input name="food_category" maxLength={60} placeholder="Italian, Thai, …" />
                </label>
                <label>
                  Price range
                  <select name="price_range" defaultValue="">
                    <option value="">Not specified</option>
                    {priceRanges.map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
                <button type="submit">Add restaurant</button>
              </fieldset>
            </form>
          </section>

          {snapshot.created_by === userId && (
            <section className="panel">
              <h3>Close poll</h3>
              <p className="muted small">End voting and save the winner. Nobody can vote after this.</p>
              {confirmingClose ? (
                <>
                  <p>Ready to close this poll?</p>
                  <div className="row">
                    <button
                      type="button"
                      disabled={busy || offline}
                      onClick={() => act(() => repository.close(pollId), () => setConfirmingClose(false))}
                    >
                      Confirm close
                    </button>
                    <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmingClose(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className="secondary" disabled={busy || offline} onClick={() => setConfirmingClose(true)}>
                  Close poll
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}
