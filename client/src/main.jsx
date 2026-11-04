import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { supabase } from './supabase.js';
import { Auth, Logo, Notice } from './ui.jsx';
import { Dashboard, Group } from './groups.jsx';
import { Poll } from './poll.jsx';
import './styles.css';

function App() {
  const [session, setSession] = useState(undefined);
  const [signOutError, setSignOutError] = useState('');
  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  async function signOut() {
    setSignOutError('');
    const { error } = await supabase.auth.signOut();
    if (error) setSignOutError('Could not sign out. Please try again.');
  }

  return (
    <>
      <header className="site-header">
        <div className="shell header-inner">
          <Link to="/" className="brand"><Logo /> Where Are We Eating?</Link>
          {session && <button className="button quiet" onClick={signOut}>Sign out</button>}
        </div>
      </header>
      <main className="shell content" id="main">
        <Notice error={signOutError} />
        {!supabase ? (
          <Notice error="Add the Supabase URL and publishable key to client/.env to start the app." />
        ) : session === undefined ? (
          <p role="status">Loading your session…</p>
        ) : !session ? <Auth /> : (
          <Routes key={session.user.id}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/groups/:groupId" element={<Group userId={session.user.id} />} />
            <Route path="/polls/:pollId" element={<Poll userId={session.user.id} />} />
            <Route path="*" element={<><h1>Page not found</h1><Link to="/">Back to your groups</Link></>} />
          </Routes>
        )}
      </main>
      <footer className="shell site-footer">Where Are We Eating? <span>Good food. Better company.</span></footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
