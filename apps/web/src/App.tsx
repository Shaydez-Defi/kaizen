/**
 * Kaizen operations console shell (T-3.6B): the imported design's sidebar,
 * lifecycle stepper and page transitions, wired to the real API through
 * ConsoleProvider (REST state + WS invalidation). Nothing is simulated.
 */

import type { JSX } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Backdrop } from './components/Backdrop';
import { NodeDrawer } from './components/NodeDrawer';
import { STEPS, ease } from './components/ui';
import { ConsoleProvider, useConsole } from './state/ConsoleContext';
import { useEventsContext } from './state/EventsContext';
import { Landing } from './pages/Landing';
import { Create } from './pages/Create';
import { Overview } from './pages/Overview';
import { Validators } from './pages/Validators';
import { Lab } from './pages/Lab';
import { Scenarios } from './pages/Scenarios';
import { Incidents } from './pages/Incidents';
import { Deployments } from './pages/Deployments';
import { V3 } from './pages/V3';
import { Settings } from './pages/Settings';

interface NavItem {
  path: string;
  label: string;
  needsNet: boolean;
}

export const NAV: NavItem[] = [
  { path: '/overview', label: 'Overview', needsNet: false },
  { path: '/validators', label: 'Validators', needsNet: true },
  { path: '/lab', label: 'Failure Lab', needsNet: true },
  { path: '/scenarios', label: 'Scenarios', needsNet: false },
  { path: '/incidents', label: 'Incidents', needsNet: true },
  { path: '/deployments', label: 'Deployments', needsNet: true },
  { path: '/v3', label: 'Portaldot V3', needsNet: false },
  { path: '/settings', label: 'Settings', needsNet: false },
];

/** Lifecycle step for the current route (−1 = not a lifecycle page). */
export function stepFor(path: string): number {
  if (path.startsWith('/create')) return 0;
  if (path.startsWith('/overview')) return 1;
  if (path.startsWith('/lab') || path.startsWith('/scenarios')) return 2;
  if (path.startsWith('/incidents')) return 3;
  if (path.startsWith('/deployments')) return 5;
  return -1;
}

function NetSelect(): JSX.Element | null {
  const { networks, selectedId, select, network } = useConsole();
  if (!networks.length) return null;
  return (
    <div className="netsel">
      <select aria-label="Selected network" value={selectedId ?? ''} onChange={(e) => select(e.target.value || null)}>
        {networks.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name} · {n.preset} · {n.status}
          </option>
        ))}
      </select>
      {network && <span className="chip">{network.status}</span>}
    </div>
  );
}

function Shell(): JSX.Element {
  const loc = useLocation();
  const nav = useNavigate();
  const { network } = useConsole();
  const { status } = useEventsContext();
  const ph = stepFor(loc.pathname);
  const section = '/' + (loc.pathname.split('/')[1] ?? '');
  return (
    <>
      <Backdrop />
      <div className="app">
        <aside className="side">
          <button type="button" className="brand" onClick={() => nav('/')}>
            KAIZEN
          </button>
          <LayoutGroup id="nav">
            <nav aria-label="Console">
              {NAV.map((n) => {
                const off = n.needsNet && !network;
                const on = n.path === section;
                return (
                  <button
                    type="button"
                    key={n.path}
                    className={`nav ${on ? 'on' : ''}`}
                    disabled={off}
                    aria-current={on ? 'page' : undefined}
                    title={off ? 'Create or select a network first' : undefined}
                    onClick={() => nav(n.path)}
                  >
                    {on && <motion.span layoutId="navpill" className="pill" transition={{ duration: 0.3, ease }} />}
                    <span>{n.label}</span>
                  </button>
                );
              })}
            </nav>
          </LayoutGroup>
          <Link to="/create" className="btn sm line" style={{ marginTop: 18 }}>
            New network
          </Link>
          <div className="cp">
            Event stream
            <br />
            <b className={status === 'open' ? 'ok' : 'warn'}>{status}</b>
          </div>
        </aside>
        <main className="main">
          <header className="top">
            <LayoutGroup id="steps">
              <ol className="steps" aria-label="Lifecycle">
                {STEPS.map((x, i) => (
                  <li key={x} className={i === ph ? 'on' : i < ph ? 'past' : ''}>
                    {i === ph && <motion.span layoutId="steppill" className="pill" transition={{ duration: 0.35, ease }} />}
                    <span>{x}</span>
                  </li>
                ))}
              </ol>
            </LayoutGroup>
            <NetSelect />
          </header>
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              className="page"
              initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease }}
            >
              <Routes location={loc}>
                <Route path="/create" element={<Create />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/validators" element={<Validators />} />
                <Route path="/lab" element={<Lab />} />
                <Route path="/scenarios" element={<Scenarios />} />
                <Route path="/incidents" element={<Incidents />} />
                <Route path="/deployments" element={<Deployments />} />
                <Route path="/v3" element={<V3 />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <NodeDrawer />
    </>
  );
}

export function App(): JSX.Element {
  return (
    <ConsoleProvider>
      <Routes>
        <Route
          index
          element={
            <>
              <Backdrop />
              <Landing />
            </>
          }
        />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </ConsoleProvider>
  );
}
