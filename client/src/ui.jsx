import React, { useState } from 'react';
import { supabase } from './supabase.js';

export function Logo() {
  return <svg className="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect width="32" height="32" rx="10" fill="currentColor" />
    <path d="M9 10v4a3 3 0 0 0 6 0v-4m-3 0v12m10-12c-2.5 2-3 4.4-3 6h3m0-6v12"
      stroke="#fff8ed" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function Notice({ error, message }) {
  if (error) return <p className="notice error" role="alert">{error}</p>;
  if (message) return <p className="notice" role="status">{message}</p>;
  return null;
}

export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(work) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function Auth() {
  const [register, setRegister] = useState(false);
  const [message, setMessage] = useState('');
  const task = useTask();
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    task.run(async () => {
      setMessage('');
      const credentials = { email: form.get('email').trim(), password: form.get('password') };
      const { data, error } = register
        ? await supabase.auth.signUp({
            ...credentials,
            options: {
              data: { display_name: form.get('displayName').trim() },
              emailRedirectTo: window.location.href.split('#')[0],
            },
          })
        : await supabase.auth.signInWithPassword(credentials);
      if (error) throw error;
      if (register && !data.session) setMessage('Check your email for a confirmation link.');
    });
  }

  return <div className="auth-grid">
    <section className="hero">
      <p className="eyebrow">The dinner decision</p>
      <h1>Let’s decide<br />where to eat.</h1>
      <p>Get everyone around the same table. Suggest restaurants, vote with friends, and see what wins.</p>
      <div className="hero-art" aria-hidden="true"><i /><i /><i /></div>
    </section>
    <section className="card auth-card">
      <p className="eyebrow">Welcome</p>
      <h2>{register ? 'Create your account' : 'Sign in'}</h2>
      <p>{register ? 'Set up your account to join a dinner poll.' : 'Open your private groups and dinner polls.'}</p>
      <form className="stack" onSubmit={submit} key={String(register)}>
        <fieldset disabled={task.busy} className="stack">
          {register && <label>Display name<input name="displayName" required maxLength={60} autoComplete="name" /></label>}
          <label>Email<input name="email" type="email" required autoComplete="email" /></label>
          <label>Password<input name="password" type="password" required minLength={register ? 8 : undefined}
            autoComplete={register ? 'new-password' : 'current-password'} /></label>
          <button className="button primary">{task.busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
        </fieldset>
      </form>
      <Notice error={task.error} message={message} />
      <button className="button text-button" disabled={task.busy} onClick={() => { setRegister(!register); setMessage(''); }}>
        {register ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
    </section>
  </div>;
}
