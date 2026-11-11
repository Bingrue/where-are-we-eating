import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [status, setStatus] = useState('Checking the API…');

  useEffect(() => {
    const controller = new AbortController();

    async function checkApi() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        setStatus(data?.status === 'ok' ? 'API connected' : 'API unavailable');
      } catch {
        if (!controller.signal.aborted) setStatus('API unavailable');
      }
    }

    checkApi();
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Where Are We Eating?</h1>
      <p role="status">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
