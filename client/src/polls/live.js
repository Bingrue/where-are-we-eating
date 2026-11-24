// Keeps one poll's snapshot up to date and reports the connection status.
//
// Realtime events are only a signal to re-read: every change triggers a fresh snapshot
// through repository.read(). Reads are serialized, and an event that arrives during a
// read queues exactly one more, so an older response can never replace newer state and
// a burst of events costs at most one extra request.
//
// Missed events are recovered by re-reading when the stream (re)connects, when the
// browser comes back online or the tab becomes visible, every `fallbackMs` while the
// stream is not confirmed live, and every `reconcileMs` even when it is (this also
// picks up deletes, which are not subscribed to).
export function watchPoll({
  repository, pollId, userId, onData, onError, onStatus,
  events = globalThis.window, visibility = globalThis.document,
  fallbackMs = 5000, reconcileMs = 30000,
}) {
  let stopped = false;
  let running = null;
  let dirty = false;
  let live = false;
  let lastRead = 0;
  let stopObserving = () => {};

  function refresh() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (running) return running;

    running = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try {
          const snapshot = await repository.read(pollId, userId);
          if (!stopped) {
            lastRead = Date.now();
            onData(snapshot);
            onError('');
          }
        } catch (error) {
          if (!stopped) onError(error.message);
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  function setStatus(value) {
    if (stopped) return;
    live = value === 'live';
    onStatus(value);
    if (live) void refresh();
  }

  const isHidden = () => visibility?.visibilityState === 'hidden';
  const onOffline = () => { live = false; onStatus('offline'); };
  const onOnline = () => { onStatus('reconnecting'); void refresh(); };
  const onVisibilityChange = () => { if (!isHidden()) void refresh(); };

  onStatus('connecting');
  try {
    stopObserving = repository.observe(pollId, refresh, setStatus);
  } catch {
    onStatus('reconnecting');
  }
  void refresh();

  const timer = setInterval(() => {
    if (!isHidden() && (!live || Date.now() - lastRead >= reconcileMs)) void refresh();
  }, fallbackMs);
  events?.addEventListener('online', onOnline);
  events?.addEventListener('offline', onOffline);
  visibility?.addEventListener('visibilitychange', onVisibilityChange);

  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      stopObserving();
      events?.removeEventListener('online', onOnline);
      events?.removeEventListener('offline', onOffline);
      visibility?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
