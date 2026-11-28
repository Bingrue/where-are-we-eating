import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { AuthScreen, NewPasswordScreen } from './AuthScreen.jsx';
import { GroupPage, GroupsPage } from './Groups.jsx';
import { PollPage } from './polls/Polls.jsx';
import { navigate, usePath } from './router.js';
import { SessionProvider, useSession } from './session.jsx';
import { isSupabaseConfigured, supabase } from './supabase.js';
import './styles.css';

const PENDING_INVITE = 'pendingInvite';

function readPendingInvite() {
  try {
    return localStorage.getItem(PENDING_INVITE);
  } catch {
    return null;
  }
}

function writePendingInvite(code) {
  try {
    if (code) localStorage.setItem(PENDING_INVITE, code);
    else localStorage.removeItem(PENDING_INVITE);
  } catch {
    // Storage unavailable: the invite still works while this page stays open.
  }
}

// Remember an invite from /join/<code> until the user is signed in, then accept it.
// localStorage (not sessionStorage) so it survives the email confirmation round trip.
function useInvite(path, session) {
  const [pending, setPending] = useState(readPendingInvite);
  const [error, setError] = useState('');
  const joining = useRef(false);

  useEffect(() => {
    const code = /^\/join\/([0-9a-f]{32})$/i.exec(path)?.[1];
    if (code) {
      writePendingInvite(code);
      setPending(code);
    }
  }, [path]);

  useEffect(() => {
    if (!session || !pending || joining.current) return;
    joining.current = true;
    api('/groups/join', { method: 'POST', body: { code: pending } })
      .then((group) => navigate(`/groups/${group.id}`, { replace: true }))
      .catch((caught) => {
        setError(caught.message);
        navigate('/', { replace: true });
      })
      .finally(() => {
        writePendingInvite(null);
        setPending(null);
        joining.current = false;
      });
  }, [session, pending]);

  return { pending, error };
}

function Header({ session }) {
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    api('/me').then(setProfile).catch(() => setProfile(null));
  }, [session?.user.id]);

  return (
    <header className="site-header">
      <h1 className="wordmark">
        <a href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>
          Where are we eating<span className="mark">?</span>
        </a>
      </h1>
      {session && (
        <div className="row account">
          <span className="muted small">{profile?.display_name || profile?.username || session.user.email}</span>
          <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      )}
    </header>
  );
}

function App() {
  const path = usePath();
  const { loading, session, recovering, finishRecovery } = useSession();
  const invite = useInvite(path, session);

  let content;
  if (!isSupabaseConfigured) {
    content = (
      <section className="table pad">
        <p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to <code>client/.env</code>, then restart <code>npm run dev</code>.</p>
      </section>
    );
  } else if (loading) {
    content = <p className="muted">Loading…</p>;
  } else if (recovering || (session && path === '/reset-password')) {
    content = <NewPasswordScreen onDone={() => { finishRecovery(); navigate('/', { replace: true }); }} />;
  } else if (!session) {
    content = <AuthScreen invitePending={Boolean(invite.pending)} />;
  } else if (invite.pending) {
    content = <p className="muted">Joining group…</p>;
  } else {
    const groupId = /^\/groups\/([^/]+)$/.exec(path)?.[1];
    const pollId = /^\/polls\/([0-9a-f-]{36})$/i.exec(path)?.[1];
    let page = <GroupsPage />;
    if (pollId) page = <PollPage key={pollId} pollId={pollId} userId={session.user.id} />;
    else if (groupId) page = <GroupPage key={groupId} groupId={groupId} userId={session.user.id} />;
    content = (
      <>
        {invite.error && <p className="error" role="alert">{invite.error}</p>}
        {page}
      </>
    );
  }

  return (
    <>
      <Header session={session} />
      <main>{content}</main>
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
