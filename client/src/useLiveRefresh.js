import { useEffect, useRef } from 'react';

// Re-run `reload` in the background so a page picks up other people's changes without
// a manual refresh: every `intervalMs` while the tab is visible, and right away when the
// tab becomes visible again, the window regains focus or the browser comes back online.
export function useLiveRefresh(reload, intervalMs = 8000) {
  const latest = useRef(reload);
  latest.current = reload;

  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== 'hidden') void latest.current();
    };
    const timer = setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
    };
  }, [intervalMs]);
}
