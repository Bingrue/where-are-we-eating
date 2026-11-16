import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { inviteLink, navigate } from './router.js';

function useApi(path) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  const reload = useCallback(async () => {
    try {
      const data = await api(path);
      setState({ loading: false, data, error: '' });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
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
      <section className="card">
        <h2>Your groups</h2>
        {groups.loading && <p>Loading…</p>}
        {groups.error && <p className="error">{groups.error}</p>}
        {groups.data?.length === 0 && <p className="muted">You are not in any groups yet. Create one or join with an invite link.</p>}
        <ul className="list">
          {groups.data?.map((group) => (
            <li key={group.id}>
              <a href={`/groups/${group.id}`} onClick={(event) => { event.preventDefault(); navigate(`/groups/${group.id}`); }}>
                {group.name}
              </a>
              <span className="muted">
                {group.member_count} {group.member_count === 1 ? 'member' : 'members'} · {group.my_role}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="columns">
        <section className="card">
          <h3>Create a group</h3>
          <form onSubmit={createGroup} className="stack">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Friday lunch crew"
              maxLength={80} required aria-label="Group name" />
            <button type="submit" disabled={busy}>Create group</button>
          </form>
        </section>
        <section className="card">
          <h3>Join a group</h3>
          <form onSubmit={joinGroup} className="stack">
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste an invite link"
              required aria-label="Invite link or code" />
            <button type="submit" disabled={busy}>Join group</button>
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

  if (group.loading) return <section className="card"><p>Loading…</p></section>;
  if (group.error) {
    return (
      <section className="card">
        <p className="error">{group.error}</p>
        <button type="button" className="link" onClick={() => navigate('/')}>Back to your groups</button>
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
      <p><button type="button" className="link" onClick={() => navigate('/')}>← Your groups</button></p>
      <section className="card">
        <h2>{data.name}</h2>
        <h3>Invite link</h3>
        <p className="muted">Anyone with this link can join the group.</p>
        <div className="row">
          <input readOnly value={link} aria-label="Invite link" onFocus={(event) => event.target.select()} />
          <button type="button" onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
          {isAdmin && <button type="button" className="secondary" onClick={rotateLink}>New link</button>}
        </div>
      </section>

      <section className="card">
        <h3>Members</h3>
        <ul className="list">
          {data.members.map((member) => (
            <li key={member.user_id}>
              <span>
                {member.profile?.display_name || member.profile?.username || 'Member'}
                {member.profile?.username && <span className="muted"> @{member.profile.username}</span>}
              </span>
              <span className="row">
                <span className="muted">{member.role}</span>
                {member.user_id === userId && (
                  <button type="button" className="link" onClick={() => removeMember(userId)}>Leave</button>
                )}
                {isAdmin && member.user_id !== userId && (
                  <button type="button" className="link" onClick={() => removeMember(member.user_id)}>Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {isAdmin && <button type="button" className="danger" onClick={deleteGroup}>Delete group</button>}
      </section>

      {/* Bingrui: poll screens for this group go here (task 6). */}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
