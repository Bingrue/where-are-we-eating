// Serialized snapshots: an event arriving during a fetch queues another fetch.
// This prevents an older request from replacing newer state, without losing bursts.
export function watchPoll({ repository, pollId, userId, onData, onError, onStatus,
  events = globalThis.window, visibility = globalThis.document, fallbackMs = 5000, reconcileMs = 30000 }) {
  let stopped = false;
  let running = null;
  let dirty = false;
  let live = false;
  let lastRead = 0;
  let stopObserve = () => {};

  function refresh() {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (running) return running;
    running = (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try {
          const value = await repository.read(pollId, userId);
          if (!stopped) { lastRead = Date.now(); onData(value); onError(''); }
        } catch (error) {
          if (!stopped) onError(error.message);
        }
      }
    })().finally(() => { running = null; });
    return running;
  }
  function status(value) {
    if (stopped) return;
    live = value === 'live';
    onStatus(value);
    if (live) void refresh();
  }
  const offline = () => { live = false; onStatus('offline'); };
  const online = () => { onStatus('reconnecting'); void refresh(); };
  const visible = () => { if (visibility?.visibilityState !== 'hidden') void refresh(); };
  onStatus('connecting');
  try { stopObserve = repository.observe(pollId, refresh, status); }
  catch { onStatus('reconnecting'); }
  void refresh();
  const timer = setInterval(() => {
    if (visibility?.visibilityState !== 'hidden' && (!live || Date.now() - lastRead >= reconcileMs)) void refresh();
  }, fallbackMs);
  events?.addEventListener('online', online);
  events?.addEventListener('offline', offline);
  visibility?.addEventListener('visibilitychange', visible);
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      stopObserve();
      events?.removeEventListener('online', online);
      events?.removeEventListener('offline', offline);
      visibility?.removeEventListener('visibilitychange', visible);
    },
  };
}
