// @vitest-environment jsdom
/**
 * Overview page tests: metrics are DERIVED from API responses (nothing
 * hardcoded), empty/loading/error states behave honestly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ApiError, apiClient } from '../api/client';
import { OverviewPage } from './OverviewPage';
import { renderPage } from '../test-utils/render';
import { makeNetwork, makeSnapshot } from '../test-utils/fixtures';

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

const listNetworks = vi.mocked(apiClient.listNetworks);
const monitorSnapshot = vi.mocked(apiClient.monitorSnapshot);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OverviewPage', () => {
  it('derives fleet metrics from real API responses', async () => {
    listNetworks.mockResolvedValue({
      ok: true,
      networks: [
        makeNetwork({ id: 'net_1', name: 'alpha', status: 'running', nodeCount: 2 }),
        makeNetwork({ id: 'net_2', name: 'beta', status: 'created', nodeCount: 1 }),
      ],
    });
    monitorSnapshot.mockResolvedValue({ ok: true, snapshot: makeSnapshot() });

    renderPage(<OverviewPage />);

    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    // metrics are derived: 2 networks, 1 running, 0 unhealthy, 3 nodes total
    expect(screen.getByTestId('tile-networks')).toHaveTextContent('2');
    expect(screen.getByTestId('tile-running')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-unhealthy')).toHaveTextContent('0');
    expect(screen.getByTestId('tile-nodes')).toHaveTextContent('3');
    expect(screen.getByText('not monitoring')).toBeInTheDocument(); // net_2 (created)
    // monitor was fetched only for the running network
    expect(monitorSnapshot).toHaveBeenCalledTimes(1);
    expect(monitorSnapshot).toHaveBeenCalledWith('net_1');
  });

  it('counts unhealthy networks from real health states', async () => {
    listNetworks.mockResolvedValue({
      ok: true,
      networks: [makeNetwork({ id: 'net_1', status: 'running' })],
    });
    monitorSnapshot.mockResolvedValue({
      ok: true,
      snapshot: makeSnapshot({
        health: [
          { nodeId: 'a', state: 'healthy', reasons: [], since: '', lastSampleAt: null, lastHealthyAt: null, rpcFailures: 0 },
          { nodeId: 'b', state: 'unhealthy', reasons: ['process crashed'], since: '', lastSampleAt: null, lastHealthyAt: null, rpcFailures: 0 },
        ],
        samples: [],
      }),
    });

    renderPage(<OverviewPage />);
    await waitFor(() => expect(screen.getByTestId('health-unhealthy')).toBeInTheDocument());
  });

  it('shows the empty state when no networks exist', async () => {
    listNetworks.mockResolvedValue({ ok: true, networks: [] });
    renderPage(<OverviewPage />);
    await waitFor(() => expect(screen.getAllByTestId('empty-state').length).toBeGreaterThan(0));
    expect(screen.getByText('No networks yet')).toBeInTheDocument();
  });

  it('shows a retryable error state when the API is down', async () => {
    listNetworks.mockRejectedValue(new ApiError('API unreachable: fetch failed', 'NETWORK_ERROR', 0));
    renderPage(<OverviewPage />);
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByText(/NETWORK_ERROR/)).toBeInTheDocument();
  });
});
