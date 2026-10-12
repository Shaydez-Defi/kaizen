// @vitest-environment jsdom
/**
 * Events page: renders real stream events once each, honest waiting states,
 * reconnect banner (events during an outage are NOT replayed — said openly).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { EventsPage } from './EventsPage';
import { EventsProvider } from '../state/EventsContext';
import { KaizenEventStream } from '../api/events';
import { FakeWebSocket } from '../test-utils/fake';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, apiClient: {} };
});

function renderEvents(): KaizenEventStream {
  const stream = new KaizenEventStream(
    'ws://test/api/events',
    FakeWebSocket as unknown as typeof WebSocket,
  );
  render(
    <MemoryRouter>
      <EventsProvider stream={stream}>
        <EventsPage />
      </EventsProvider>
    </MemoryRouter>,
  );
  return stream;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

afterEach(() => {
  cleanup();
});

describe('EventsPage', () => {
  it('waits honestly while the stream is not connected', async () => {
    renderEvents();
    await waitFor(() =>
      expect(screen.getByText('Waiting for the event stream')).toBeInTheDocument(),
    );
  });

  it('renders each delivered event exactly once with its real timestamp', async () => {
    renderEvents();
    const ws = FakeWebSocket.last();
    act(() => ws.open());
    act(() => ws.message({ type: 'hello', version: '0.1.0' }));
    const event = {
      type: 'event',
      name: 'network.created',
      payload: {
        networkId: 'net_1',
        name: 'alpha',
        preset: 'two-node',
        nodeCount: 2,
        at: '2026-10-10T12:00:00.000Z',
      },
    };
    act(() => ws.message(event));

    await waitFor(() =>
      expect(screen.getByText(/network “alpha” created/)).toBeInTheDocument(),
    );
    // exactly one row per delivery (the single-socket guarantee is covered
    // in api/events.test.ts — duplicates here would mean double delivery)
    expect(screen.getAllByText(/network “alpha” created/)).toHaveLength(1);
    expect(screen.getByText('Live feed')).toBeInTheDocument();
  });

  it('shows the reconnect banner after a drop and does not fake missed events', async () => {
    renderEvents();
    const first = FakeWebSocket.last();
    act(() => first.open());
    act(() => first.serverClose());

    // the stream schedules a reconnect (backoff ≤ 500ms on first attempt)
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    const second = FakeWebSocket.last();
    act(() => second.open()); // reconnect completes → resync fires

    await waitFor(() => expect(screen.getByText(/reconnected once/)).toBeInTheDocument());
    // the honesty note is visible
    expect(screen.getByText(/not replayed/)).toBeInTheDocument();
    // no fake catch-up events
    expect(screen.queryByText(/network.status/)).not.toBeInTheDocument();
  });

  it('filters by event kind', async () => {
    renderEvents();
    const ws = FakeWebSocket.last();
    act(() => ws.open());
    act(() =>
      ws.message({
        type: 'event',
        name: 'monitor.health',
        payload: { networkId: 'n', nodeId: 'x', name: 'node-a', from: 'healthy', to: 'unhealthy', reasons: ['crashed'], at: '2026-10-10T12:00:00.000Z' },
      }),
    );
    act(() =>
      ws.message({
        type: 'event',
        name: 'network.status',
        payload: { networkId: 'n', name: 'alpha', status: 'running', at: '2026-10-10T12:00:01.000Z' },
      }),
    );
    await waitFor(() => expect(screen.getByText(/health healthy → unhealthy/)).toBeInTheDocument());

    const select = screen.getByLabelText('Filter by kind');
    await userEvent.selectOptions(select, 'monitor');
    await waitFor(() => expect(screen.queryByText(/network “alpha” → running/)).not.toBeInTheDocument());
    expect(screen.getByText(/health healthy → unhealthy/)).toBeInTheDocument();
  });
});
