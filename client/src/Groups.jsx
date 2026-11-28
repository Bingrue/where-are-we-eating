import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { GroupPolls } from './polls/Polls.jsx';
import { inviteLink, navigate } from './router.js';
import { useLiveRefresh } from './useLiveRefresh.js';

// Load an API path, then keep it fresh in the background. A failed background reload
// keeps showing the last good data instead of blanking the page.
function useApi(path) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  const reload = useCallback(async () => {
    try {
      const data = await api(path);
      setState({ loading: false, data, error: '' });
    } catch (error) {
      setState((previous) => ({
        loading: false,
        data: previous.data,
        error: previous.data ? '' : error.message,
      }));
    }
  }, [path]);

  useEffect(() => {
    setState({ loading: true, data: null, error: '' });
    reload();
  }, [reload]);

  useLiveRefresh(reload);

  return { ...state, reload };
}

const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';

function BackLink({ to, children }) {
  return (
    <a className="back" href={to} onClick={(event) => { event.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function GroupsPage() {
  const groups = useApi('/groups');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  const createGroup = (event) => {
    event.preventDefault();
    run(async () => {
      const group = await api('/groups', { method: 'POST', body: { name } });
      setName('');
      navigate(`/groups/${group.id}`);
    });
  };

  const joinGroup = (event) => {
    event.preventDefault();
    run(async () => {
      const group = await api('/groups/join', { method: 'POST', body: { code } });
      setCode('');
      navigate(`/groups/${group.id}`);
    });
  };

  return (
    <>
      <section className="page-intro">
        <h2 className="display">Your groups</h2>
        <p className="muted">Pick a group to see its polls, or start a new one.</p>
      </section>

      <section className="table">
        {groups.loading && <p className="muted pad">Loading your groups…</p>}
        {groups.error && <p className="error pad" role="alert">{groups.error}</p>}
        {groups.data?.length === 0 && (
          <p className="empty">You’re not in a group yet. Create one below, or paste an invite link a friend sent you.</p>
        )}
        {groups.data?.length > 0 && (
          <ul className="rows">
            {groups.data.map((group) => (
              <li key={group.id}>
                <a
                  className="row-link"
                  href={`/groups/${group.id}`}
                  onClick={(event) => { event.preventDefault(); navigate(`/groups/${group.id}`); }}
                >
                  <span className="avatar" aria-hidden="true">{initials(group.name)}</span>
                  <span className="row-main">
                    <span className="row-title">{group.name}</span>
                    <span className="muted small">
                      {group.member_count} {group.member_count === 1 ? 'member' : 'members'}
                    </span>
                  </span>
                  {group.my_role === 'admin' && <span className="chip">Admin</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="columns">
        <section className="panel">
          <h3>Create a group</h3>
          <form onSubmit={createGroup} className="stack">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Friday lunch crew"
              maxLength={80} required aria-label="Group name" />
            <button type="submit" disabled={busy}>Create group</button>
          </form>
        </section>
        <section className="panel">
          <h3>Join a group</h3>
          <form onSubmit={joinGroup} className="stack">
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste an invite link"
              required aria-label="Invite link or code" />
            <button type="submit" className="secondary" disabled={busy}>Join group</button>
          </form>
        </section>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

export function GroupPage({ groupId, userId }) {
  const group = useApi(`/groups/${groupId}`);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function act(action) {
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught.message);
    }
  }

  if (group.loading) return <p className="muted">Loading group…</p>;
  if (group.error) {
    return (
      <section className="table pad">
        <p className="error" role="alert">{group.error}</p>
        <BackLink to="/">← Your groups</BackLink>
      </section>
    );
  }

  const data = group.data;
  const isAdmin = data.my_role === 'admin';
  const link = inviteLink(data.invite_code);

  const copyLink = () => act(async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
  const rotateLink = () => act(async () => {
    await api(`/groups/${groupId}/invite`, { method: 'POST' });
    await group.reload();
  });
  const removeMember = (memberId) => act(async () => {
    await api(`/groups/${groupId}/members/${memberId}`, { method: 'DELETE' });
    if (memberId === userId) navigate('/');
    else await group.reload();
  });
  const deleteGroup = () => act(async () => {
    if (!window.confirm(`Delete ${data.name} and all of its polls?`)) return;
    await api(`/groups/${groupId}`, { method: 'DELETE' });
    navigate('/');
  });

  return (
    <>
      <BackLink to="/">← Your groups</BackLink>
      <section className="page-intro">
        <h2 className="display">{data.name}</h2>
        <p className="muted">
          {data.members.length} {data.members.length === 1 ? 'member' : 'members'}
        </p>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <GroupPolls key={groupId} groupId={groupId} />

      <div className="columns">
        <section className="panel">
          <h3>Members</h3>
          <ul className="people">
            {data.members.map((member) => {
              const name = member.profile?.display_name || member.profile?.username || 'Member';
              return (
                <li key={member.user_id}>
                  <span className="avatar small" aria-hidden="true">{initials(name)}</span>
                  <span className="row-main">
                    <span>
                      {name}
                      {member.user_id === userId && <span className="muted"> (you)</span>}
                    </span>
                    {member.profile?.username && <span className="muted small">@{member.profile.username}</span>}
                  </span>
                  {member.role === 'admin' && <span className="chip">Admin</span>}
                  {member.user_id === userId && (
                    <button type="button" className="link" onClick={() => removeMember(userId)}>Leave</button>
                  )}
                  {isAdmin && member.user_id !== userId && (
                    <button type="button" className="link" onClick={() => removeMember(member.user_id)}>Remove</button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <h3>Invite friends</h3>
          <p className="muted small">Anyone with this link can join the group.</p>
          <div className="stack">
            <input readOnly value={link} aria-label="Invite link" onFocus={(event) => event.target.select()} />
            <div className="row">
              <button type="button" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
              {isAdmin && <button type="button" className="secondary" onClick={rotateLink}>Make a new link</button>}
            </div>
          </div>
          {isAdmin && (
            <button type="button" className="danger" onClick={deleteGroup}>Delete group</button>
          )}
        </section>
      </div>
    </>
  );
}
