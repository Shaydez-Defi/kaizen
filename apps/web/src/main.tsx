/**
 * Kaizen web UI — Phase 1 scaffold.
 *
 * This is intentionally a minimal placeholder: it only proves the frontend
 * workspace builds and can reach the API. The real network dashboard is
 * Phase 2 work (tasks T-2.5/T-2.6). No operational features are claimed here.
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
}

function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'API unreachable'),
      );
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem' }}>
      <h1>Kaizen</h1>
      <p>Portaldot node operations platform — Phase 1 scaffold.</p>
      {health ? (
        <p>
          API: <strong>{health.service}</strong> v{health.version} — connected.
        </p>
      ) : null}
      {error ? <p style={{ color: '#b00020' }}>API unreachable: {error}</p> : null}
      <p>The network dashboard arrives in Phase 2.</p>
    </main>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');
createRoot(rootEl).render(<App />);
