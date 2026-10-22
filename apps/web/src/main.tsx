/**
 * Kaizen web UI — operations console over the real backend (Phase 2B).
 *
 * Renders ONLY engine-produced data: every number comes from the REST API
 * or the WebSocket event stream. No mock data, no simulated nodes (DEC-009).
 * The browser never launches processes — all operations go through the
 * backend (FR-1).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { EventsProvider } from './state/EventsContext';
// Self-hosted fonts (T-3.6C): no runtime Google Fonts dependency.
import '@fontsource/hanken-grotesk/300.css';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/bodoni-moda/400.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');
createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <EventsProvider>
        <App />
      </EventsProvider>
    </BrowserRouter>
  </StrictMode>,
);
