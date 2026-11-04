import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { command, supabase, unwrap } from './supabase.js';
import { Notice, useTask } from './ui.jsx';

const groupFields = 'id,name,created_by,created_at';
const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const pageSize = 20;

function useQuery(load, key) {
  const [state, setState] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().then((data) => {
      if (!cancelled) setState({ key, data });
    }).catch((error) => {
      if (!cancelled) setState({ key, error: error.message });
    });
    return () => { cancelled = true; };
  }, [key, attempt]); // The caller supplies a key covering all query parameters.
  return {
    data: state?.key === key ? state.data : undefined,
    error: state?.key === key ? state.error : undefined,
    refresh: () => setAttempt((value) => value + 1),
  };
}

export function Dashboard() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const [page, setPage] = useState(0);
  const query = useQuery(async () => unwrap(await supabase.from('groups').select(groupFields)
    .order('created_at', { ascending: false }).order('id')
    .range(page * pageSize, (page + 1) * pageSize)), page);
  const create = useTask();
  const join = useTask();

  function submit(event, task, path, field) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get(field);
    task.run(async () => navigate('/groups/' + await command(path, { [field]: value })));
  }

  return <>
    <section className="hero compact">
      <p className="eyebrow">Your dinner plans</p>
      <h1>Pull up a chair.</h1>
      <p>Start a private dining group or join one with a friend’s invitation.</p>
    </section>
    <div className="two-columns">
      <section className="card">
        <h2>Create a group</h2>
        <form className="stack" onSubmit={(event) => submit(event, create, '/groups', 'name')}>
          <label>Group name<input name="name" required maxLength={80} placeholder="Friday dinner crew" /></label>
          <button className="button primary" disabled={create.busy}>Create group</button>
        </form>
        <Notice error={create.error} />
      </section>
      <section className="card">
        <h2>Join a group</h2>
        <form className="stack" onSubmit={(event) => submit(event, join, '/groups/join', 'invite')}>
          <label>Invitation code<input name="invite" required maxLength={32}
            defaultValue={search.get('invite') ?? ''} autoCapitalize="none" spellCheck={false} /></label>
          <button className="button secondary" disabled={join.busy}>Join group</button>
        </form>
        <Notice error={join.error} />
      </section>
    </div>
    <section className="card">
      <h2>Your groups</h2>
      <QueryStatus query={query} />
      {query.data?.length === 0 && <p>No groups on this page.</p>}
      {query.data && <ul className="row-list">{query.data.slice(0, pageSize).map((group) =>
        <li key={group.id}><Link to={'/groups/' + group.id}><strong>{group.name}</strong><span aria-hidden="true">↗</span></Link></li>
      )}</ul>}
      <Pager page={page} setPage={setPage} hasNext={query.data?.length > pageSize} />
    </section>
  </>;
}

function QueryStatus({ query }) {
  if (query.error) return <><Notice error={query.error} /><button className="button secondary" onClick={query.refresh}>Retry</button></>;
  if (!query.data) return <p role="status">Loading…</p>;
  return null;
}

function Pager({ page, setPage, hasNext }) {
  if (!page && !hasNext) return null;
  return <nav className="pager" aria-label="Pages">
    <button className="button quiet" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
    <span>Page {page + 1}</span>
    <button className="button quiet" disabled={!hasNext} onClick={() => setPage(page + 1)}>Next</button>
  </nav>;
}

export function Group({ userId }) {
  const { groupId } = useParams();
  return <GroupView key={groupId} groupId={groupId} userId={userId} />;
}

function GroupView({ groupId, userId }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const create = useTask();
  const invitation = useTask();
  const group = useQuery(async () => {
    const result = unwrap(await supabase.from('groups').select(groupFields).eq('id', groupId).maybeSingle());
    if (!result) throw new Error('This private group could not be found.');
    return result;
  }, groupId);
  const polls = useQuery(async () => unwrap(await supabase.from('polls')
    .select('id,question,status,closed_at,created_at,outcome')
    .eq('group_id', groupId).order('created_at', { ascending: false }).order('id')
    .range(page * pageSize, (page + 1) * pageSize)), groupId + ':' + page);

  function submit(event) {
    event.preventDefault();
    const question = new FormData(event.currentTarget).get('question');
    create.run(async () => navigate('/polls/' + await command('/groups/' + groupId + '/polls', { question })));
  }

  function showInvite() {
    invitation.run(async () => setCode(await command('/groups/' + groupId + '/invite', undefined, 'GET')));
  }

  return <>
    <Link className="back-link" to="/">← Your groups</Link>
    <QueryStatus query={group} />
    {group.data && <>
      <section className="hero compact">
        <p className="eyebrow">Private dining group</p>
        <h1>{group.data.name}</h1>
        <p>Start a poll for your next meal or see what won last time.</p>
      </section>
      <div className="two-columns">
        <section className="card">
          <h2>Start a poll</h2>
          <form className="stack" onSubmit={submit}>
            <label>Question<input name="question" required maxLength={160} placeholder="Where should we eat on Friday?" /></label>
            <button className="button primary" disabled={create.busy}>Create poll</button>
          </form>
          <Notice error={create.error} />
        </section>
        {group.data.created_by === userId && <section className="card">
          <h2>Invite friends</h2>
          <p>Anyone with this link can join after signing in.</p>
          {code ? <>
            <label>Invitation link<input readOnly value={window.location.origin + '/?invite=' + code}
              onFocus={(event) => event.currentTarget.select()} /></label>
            {navigator.clipboard && <button className="button secondary space-top" onClick={() => invitation.run(async () => {
              await navigator.clipboard.writeText(window.location.origin + '/?invite=' + code);
              setCopied(true);
            })}>Copy link</button>}
          </> : <button className="button secondary" disabled={invitation.busy} onClick={showInvite}>Show invite</button>}
          <Notice error={invitation.error} message={copied ? 'Invitation copied.' : ''} />
        </section>}
      </div>
      <section className="card">
        <h2>Group polls</h2>
        <QueryStatus query={polls} />
        {polls.data?.length === 0 && <p>No polls on this page.</p>}
        {polls.data && <ul className="row-list">{polls.data.slice(0, pageSize).map((poll) => {
          const winner = poll.outcome?.options.find((option) => option.id === poll.outcome.winner_option_id);
          return <li key={poll.id}><Link to={'/polls/' + poll.id}>
            <span><strong>{poll.question}</strong>
              <small>{poll.status === 'open' ? 'Created ' + date.format(new Date(poll.created_at))
                : winner ? 'Winner: ' + winner.name : 'Closed without votes'}</small></span>
            <span className={'badge ' + poll.status}>{poll.status === 'open' ? 'Open' : 'Closed'}</span>
          </Link></li>;
        })}</ul>}
        <Pager page={page} setPage={setPage} hasNext={polls.data?.length > pageSize} />
      </section>
    </>}
  </>;
}
