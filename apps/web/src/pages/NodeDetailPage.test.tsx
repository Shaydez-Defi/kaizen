// @vitest-environment jsdom
/** Node detail: identity, honest unreachable rendering, log tail, controls. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { NodeDetailPage } from './NodeDetailPage';
import { renderPage } from '../test-utils/render';
import { makeHealth, makeNode, makeSample } from '../test-utils/fixtures';

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

const getNode = vi.mocked(apiClient.getNode);
const nodeLogs = vi.mocked(apiClient.nodeLogs);
const stopNode = vi.mocked(apiClient.stopNode);

function renderNode(): void {
  renderPage(
    <Routes>
      <Route path="/networks/:networkId/nodes/:nodeId" element={<NodeDetailPage />} />
    </Routes>,
    { route: '/networks/net_1/nodes/net_1-alice' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NodeDetailPage', () => {
  it('shows live chain data and the captured log tail for a running node', async () => {
    getNode.mockResolvedValue({
      ok: true,
      node: makeNode({ status: 'running', pid: 4242 }),
      sample: makeSample(),
      health: makeHealth(),
    });
    nodeLogs.mockResolvedValue({
      ok: true,
      nodeId: 'net_1-alice',
      lines: ['2026-10-10 12:00:01 Starting node', '2026-10-10 12:00:02 Idle'],
    });
    renderNode();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'demo-alice' })).toBeInTheDocument());
    expect(screen.getByText('#12')).toBeInTheDocument();
    expect(screen.getByTestId('health-healthy')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Idle/)).toBeInTheDocument());
    // running node → Stop offered
    expect(screen.getByRole('button', { name: 'Stop node' })).toBeInTheDocument();

    stopNode.mockResolvedValue({
      ok: true,
      result: { ok: true, operationId: 2, kind: 'node.stop', startedAt: '', finishedAt: '', durationMs: 5 },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Stop node' }));
    await waitFor(() => expect(stopNode).toHaveBeenCalledWith('net_1', 'net_1-alice'));
  });

  it('renders an explicit unreachable state instead of numbers', async () => {
    getNode.mockResolvedValue({
      ok: true,
      node: makeNode({ status: 'running' }),
      sample: makeSample({
        rpc: { reachable: false, error: 'connect ECONNREFUSED 127.0.0.1:9933' },
        head: null,
        finalized: null,
        peers: null,
      }),
      health: makeHealth({ state: 'unavailable', reasons: ['RPC unreachable for 3 consecutive checks'] }),
    });
    nodeLogs.mockResolvedValue({ ok: true, nodeId: 'net_1-alice', lines: [] });
    renderNode();

    await waitFor(() => expect(screen.getByTestId('rpc-unreachable')).toBeInTheDocument());
    expect(screen.getByTestId('rpc-unreachable')).toHaveTextContent(/ECONNREFUSED/);
    expect(screen.getByTestId('health-unavailable')).toBeInTheDocument();
    // the honest "no logs yet" state
    expect(screen.getByTestId('no-logs')).toBeInTheDocument();
  });

  it('shows an error state for an unknown node', async () => {
    getNode.mockRejectedValue(new ApiError('No node', 'NODE_NOT_FOUND', 404));
    nodeLogs.mockRejectedValue(new ApiError('No node', 'NODE_NOT_FOUND', 404));
    renderNode();
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByText(/NODE_NOT_FOUND/)).toBeInTheDocument();
  });
});
