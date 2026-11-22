import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const SessionContext = createContext(null);

// Tracks the Supabase Auth session for the whole app.
// onAuthStateChange fires INITIAL_SESSION on load (restoring a saved session), then
// SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED and PASSWORD_RECOVERY.
export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, session: null, recovering: false });

  useEffect(() => {
    if (!supabase) {
      setState({ loading: false, session: null, recovering: false });
      return undefined;
    }

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Keep this callback synchronous: Supabase warns against awaiting other
      // supabase calls inside it.
      setState((previous) => ({
        loading: false,
        session,
        recovering: event === 'PASSWORD_RECOVERY'
          ? true
          : event === 'SIGNED_OUT' ? false : previous.recovering,
      }));
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const finishRecovery = () => setState((previous) => ({ ...previous, recovering: false }));

  return (
    <SessionContext.Provider value={{ ...state, finishRecovery }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
