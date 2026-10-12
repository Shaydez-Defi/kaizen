// @vitest-environment jsdom
/** Network detail: node/monitor tables, honest unreachable rendering, controls. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { NetworkDetailPage } from './NetworkDetailPage';
import { renderPage } from '../test-utils/render';
import { makeHealth, makeNetwork, makeNode, makeSample, makeSnapshot } from '../test-utils/fixtures';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: {
      listNetworks: vi.fn(),
      monitorSnapshot: vi.fn(),
      getNetwork: vi.fn(),
      getNode: vi.fn(),
      nodeLogs: vi.fn(),
      createNetwork: vi.fn(),
      startNetwork: vi.fn(),
      stopNetwork: vi.fn(),
      purgeNetwork: vi.fn(),
      removeNetwork: vi.fn(),
      startNode: vi.fn(),
      stopNode: vi.fn(),
    },
  };
});

const getNetwork = vi.mocked(apiClient.getNetwork);
const monitorSnapshot = vi.mocked(apiClient.monitorSnapshot);
const startNetwork = vi.mocked(apiClient.startNetwork);
const purgeNetwork = vi.mocked(apiClient.purgeNetwork);

function renderDetail(): void {
  renderPage(
    <Routes>
      <Route path="/networks/:networkId" element={<NetworkDetailPage />} />
    </Routes>,
    { route: '/networks/net_1' },
  );
}

const okOp = { ok: true, result: { ok: true, operationId: 1, kind: 'x', startedAt: '', finishedAt: '', durationMs: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NetworkDetailPage', () => {
  it('renders node configuration and live monitoring data', async () => {
    getNetwork.mockResolvedValue({
      ok: true,
      network: makeNetwork({ status: 'running' }),
      nodes: [makeNode(), makeNode({ id: 'net_1-bob', name: 'demo-bob', wellKnownKey: 'bob' })],
    });
    monitorSnapshot.mockResolvedValue({
      ok: true,
      snapshot: makeSnapshot({
        samples: [
          makeSample(),
          makeSample({
            nodeId: 'net_1-bob',
            name: 'demo-bob',
            rpc: { reachable: false, error: 'ECONNREFUSED' },
            head: null,
            finalized: null,
            peers: null,
            health: null,
          }),
        ],
        health: [makeHealth(), makeHealth({ nodeId: 'net_1-bob', state: 'unavailable', reasons: ['RPC unreachable for 3 consecutive checks'] })],
      }),
    });
    renderDetail();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'demo' })).toBeInTheDocument());
    // nodes table + monitor table each link the node (2 rows total)
    expect(screen.getAllByText('demo-alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('demo-bob').length).toBeGreaterThan(0);
    // live table: real numbers for alice
    expect(screen.getByTestId('health-healthy')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument(); // peers 1/1
    expect(screen.getByText('#12')).toBeInTheDocument(); // best block
    // bob is honestly unreachable — no invented numbers
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    expect(screen.getByTestId('health-unavailable')).toBeInTheDocument();
    // running network → Stop offered, Purge/Remove disabled
    expect(screen.getByRole('button', { name: 'Stop network' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purge chain data' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('offers Start for a stopped network and runs it', async () => {
    getNetwork.mockResolvedValue({
      ok: true,
      network: makeNetwork({ status: 'stopped' }),
      nodes: [makeNode({ status: 'stopped' })],
    });
    startNetwork.mockResolvedValue(okOp);
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start network' })).toBeInTheDocument());
    // monitoring is off while stopped — the section says so instead of faking data
    expect(screen.getByTestId('monitor-off')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Start network' }));
    await waitFor(() => expect(startNetwork).toHaveBeenCalledWith('net_1'));
    // data refetched after the mutation (actual backend state is re-read)
    await waitFor(() => expect(getNetwork).toHaveBeenCalledTimes(2));
  });

  it('confirms before purging chain data', async () => {
    getNetwork.mockResolvedValue({
      ok: true,
      network: makeNetwork({ status: 'stopped' }),
      nodes: [makeNode({ status: 'stopped' })],
    });
    purgeNetwork.mockResolvedValue(okOp);
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Purge chain data' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Purge chain data' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone|fresh genesis/i)).toBeInTheDocument();

    // cancel does nothing
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(purgeNetwork).not.toHaveBeenCalled();

    // confirm calls the API
    await userEvent.click(screen.getByRole('button', { name: 'Purge chain data' }));
    const dialog2 = await screen.findByRole('dialog');
    await userEvent.click(within(dialog2).getByRole('button', { name: 'Purge chain data' }));
    await waitFor(() => expect(purgeNetwork).toHaveBeenCalledWith('net_1'));
  });

  it('shows an error state when the network cannot be loaded', async () => {
    getNetwork.mockRejectedValue(
      Object.assign(new ApiError('No network net_nope', 'NETWORK_NOT_FOUND', 404), {}),
    );
    renderDetail();
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByText(/NETWORK_NOT_FOUND/)).toBeInTheDocument();
  });
});
