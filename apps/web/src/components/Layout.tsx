/** App shell: header, navigation, live-connection indicator, outlet. */

import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useEventsContext } from '../state/EventsContext';
import { ConnectionBanner } from './States';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/networks', label: 'Networks', end: false },
  { to: '/events', label: 'Events', end: false },
];

export function Layout(): JSX.Element {
  const { status } = useEventsContext();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Kaizen</span>
          <span className="brand-sub">Portaldot operations</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="conn" title="Live event stream status">
          <span className={`conn-dot conn-${status}`} aria-hidden="true" />
          <span className="conn-text">
            {status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
          </span>
        </div>
      </header>
      <ConnectionBanner status={status} />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
