/** Routes for the Kaizen operations console (T-2.5/T-2.6). */

import type { JSX } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { NetworksPage } from './pages/NetworksPage';
import { NetworkDetailPage } from './pages/NetworkDetailPage';
import { NodeDetailPage } from './pages/NodeDetailPage';
import { EventsPage } from './pages/EventsPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="networks" element={<NetworksPage />} />
        <Route path="networks/:networkId" element={<NetworkDetailPage />} />
        <Route path="networks/:networkId/nodes/:nodeId" element={<NodeDetailPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Not found</h1>
              <p className="muted">That page does not exist.</p>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
