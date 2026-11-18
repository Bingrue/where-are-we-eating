import { useState } from 'react';
import { supabase } from './supabase.js';

const usernamePattern = /^[a-z0-9_]{3,20}$/;

// Supabase Auth reports a failure in our on_auth_user_created trigger as a generic
// database error. The only constraint that trigger can break is the unique username.
function describeAuthError(error) {
  if (/database error saving new user/i.test(error.message)) {
    return 'That username is already taken.';
  }
  if (error.code === 'over_email_send_rate_limit') {
    return 'Too many emails were sent. Wait a few minutes and try again.';
  }
  return error.message;
}

export function AuthScreen({ invitePending }) {
  const [mode, setMode] = useState('sign-in');
  const [form, setForm] = useState({ email: '', password: '', username: '', displayName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  function switchMode(next) {
    setMode(next);
    setError('');
    setNotice('');
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');

    try {
      if (mode === 'sign-in') {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: form.email,
          password: form.password,
        });
        if (authError) throw authError;
        // onAuthStateChange (SIGNED_IN) takes it from here.
      } else if (mode === 'sign-up') {
        const username = form.username.trim().toLowerCase();
        if (!usernamePattern.test(username)) {
          throw new Error('Usernames are 3–20 lowercase letters, numbers or underscores.');
        }
        const { data, error: authError } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: {
            // Stored in auth.users.raw_user_meta_data; the on_auth_user_created
            // trigger copies them into public.profiles.
            data: { username, display_name: form.displayName.trim() || username },
            // Where the confirmation email sends the user back to.
            emailRedirectTo: window.location.href,
          },
        });
        if (authError) throw authError;
        if (!data.session) {
          // Email confirmation is on: Supabase sent a confirmation link.
          setNotice('Check your email and open the confirmation link to finish signing up.');
          setMode('sign-in');
        }
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(form.email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (authError) throw authError;
        setNotice('If that email has an account, a password reset link is on its way.');
      }
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setBusy(false);
    }
  }

  const title = { 'sign-in': 'Sign in', 'sign-up': 'Create an account', reset: 'Reset your password' }[mode];

  return (
    <section className="card narrow">
      <h2>{title}</h2>
      {invitePending && <p className="notice">Sign in or create an account to join the group you were invited to.</p>}

      <form onSubmit={submit} className="stack">
        {mode === 'sign-up' && (
          <>
            <label>
              Display name
              <input value={form.displayName} onChange={update('displayName')} maxLength={60}
                autoComplete="name" placeholder="How friends see you" />
            </label>
            <label>
              Username
              <input value={form.username} onChange={update('username')} required maxLength={20}
                autoComplete="username" placeholder="lowercase_letters_123" />
            </label>
          </>
        )}
        <label>
          Email
          <input type="email" value={form.email} onChange={update('email')} required autoComplete="email" />
        </label>
        {mode !== 'reset' && (
          <label>
            Password
            <input type="password" value={form.password} onChange={update('password')} required minLength={6}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} />
          </label>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : { 'sign-in': 'Sign in', 'sign-up': 'Create account', reset: 'Send reset link' }[mode]}
        </button>
      </form>

      <p className="links">
        {mode !== 'sign-in' && <button type="button" className="link" onClick={() => switchMode('sign-in')}>Sign in</button>}
        {mode !== 'sign-up' && <button type="button" className="link" onClick={() => switchMode('sign-up')}>Create an account</button>}
        {mode !== 'reset' && <button type="button" className="link" onClick={() => switchMode('reset')}>Forgot password?</button>}
      </p>
    </section>
  );
}

// Shown after the user opens a password reset link (PASSWORD_RECOVERY event).
export function NewPasswordScreen({ onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const { error: authError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (authError) setError(authError.message);
    else onDone();
  }

  return (
    <section className="card narrow">
      <h2>Choose a new password</h2>
      <form onSubmit={submit} className="stack">
        <label>
          New password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
            required minLength={6} autoComplete="new-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
    </section>
  );
}
