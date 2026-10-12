// @vitest-environment jsdom
/** Networks page: list rendering, filtering, creation flow + API errors. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { NetworksPage } from './NetworksPage';
import { renderPage } from '../test-utils/render';
import { makeNetwork } from '../test-utils/fixtures';

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
const createNetwork = vi.mocked(apiClient.createNetwork);

function renderNetworks(): void {
  renderPage(
    <Routes>
      <Route path="/networks" element={<NetworksPage />} />
      <Route path="/networks/:networkId" element={<div>detail page</div>} />
    </Routes>,
    { route: '/networks' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NetworksPage', () => {
  it('lists networks with real fields and filters client-side', async () => {
    listNetworks.mockResolvedValue({
      ok: true,
      networks: [
        makeNetwork({ id: 'net_1', name: 'alpha', preset: 'two-node', nodeCount: 2 }),
        makeNetwork({ id: 'net_2', name: 'bravo', preset: 'four-validator', nodeCount: 4 }),
      ],
    });
    renderNetworks();
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.getByText('four-validator')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Filter networks'), 'bra');
    await waitFor(() => expect(screen.queryByText('alpha')).not.toBeInTheDocument());
    expect(screen.getByText('bravo')).toBeInTheDocument();
  });

  it('creates a network and navigates to its detail page', async () => {
    listNetworks.mockResolvedValue({ ok: true, networks: [] });
    createNetwork.mockResolvedValue({ ok: true, network: { id: 'net_new' } });
    renderNetworks();
    await waitFor(() => expect(screen.getByText('No networks yet')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /create network/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'fresh-net');
    await userEvent.click(screen.getByRole('button', { name: 'Create network' }));

    await waitFor(() =>
      expect(createNetwork).toHaveBeenCalledWith({ name: 'fresh-net', preset: 'two-node' }),
    );
    await waitFor(() => expect(screen.getByText('detail page')).toBeInTheDocument());
  });

  it('surfaces structured validation errors from the API', async () => {
    listNetworks.mockResolvedValue({ ok: true, networks: [] });
    createNetwork.mockRejectedValue(
      new ApiError('Invalid network creation request', 'INVALID_INPUT', 400, {
        issues: [{ message: 'name must match ^[a-z0-9][a-z0-9_-]{0,31}$' }],
      }),
    );
    renderNetworks();
    await waitFor(() => expect(screen.getByRole('button', { name: /create network/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /create network/i }));
    await userEvent.type(screen.getByLabelText('Name'), 'BAD NAME');
    await userEvent.click(screen.getByRole('button', { name: 'Create network' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('INVALID_INPUT');
    expect(screen.getByRole('alert')).toHaveTextContent(/name must match/);
  });

  it('shows the empty state and an error state when the list call fails', async () => {
    listNetworks.mockRejectedValue(new ApiError('API unreachable: x', 'NETWORK_ERROR', 0));
    renderNetworks();
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
