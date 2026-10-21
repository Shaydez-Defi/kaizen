// @vitest-environment jsdom
/**
 * Console shell + Overview + node drawer (T-3.6B): real API records render,
 * unknowns render as "—", operations go through the typed client only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-utils/render';
import { apiClient } from '../api/client';
import { App, stepFor } from '../App';
import { Overview } from './Overview';
import { NodeDrawer, diagnose } from '../components/NodeDrawer';
import { primeApi, okOp, ALICE, type ApiMock } from '../test-utils/mockApi';
import { pushEvent, renderConsole } from '../test-utils/renderConsole';
import { FakeWebSocket } from '../test-utils/fake';
import { makeHealth, makeSample } from '../test-utils/fixtures';

vi.mock('../api/client', async (orig) => {
  const actual = await orig<typeof import('../api/client')>();
  const { makeApiMock } = await import('../test-utils/mockApi');
  return { ...actual, apiClient: makeApiMock() };
});
const api = apiClient as unknown as ApiMock;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  primeApi(api);
});

describe('App shell', () => {
  it('maps routes to lifecycle steps', () => {
    expect(stepFor('/create')).toBe(0);
    expect(stepFor('/overview')).toBe(1);
    expect(stepFor('/lab')).toBe(2);
    expect(stepFor('/incidents')).toBe(3);
    expect(stepFor('/deployments')).toBe(5);
    expect(stepFor('/v3')).toBe(-1);
  });

  it('landing shows real control-plane status and launches the console', async () => {
    renderConsole(<App />, { route: '/', withConsole: false });
    expect((await screen.findAllByText(/Control plane connected · v0.1.0/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Launch console/ }));
    expect(await screen.findByRole('navigation', { name: 'Console' })).toBeInTheDocument();
  });

  it('landing reports an unreachable control plane honestly', async () => {
    api.health.mockRejectedValue(new Error('down'));
    renderConsole(<App />, { route: '/', withConsole: false });
    expect((await screen.findAllByText(/Control plane unreachable/)).length).toBeGreaterThan(0);
  });

  it('disables network-scoped nav without a network and offers create', async () => {
    primeApi(api, { empty: true });
    renderConsole(<App />, { route: '/overview', withConsole: false });
    expect(await screen.findByText('No network selected')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Console' });
    expect(within(nav).getByRole('button', { name: 'Failure Lab' })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Portaldot V3' })).toBeEnabled();
  });
});

describe('Overview', () => {
  it('renders real nodes, heights and observed links', async () => {
    renderConsole(<Overview />);
    expect(await screen.findByText('Network healthy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-alice, Synced/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-bob, Synced/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('#121')).toBeInTheDocument());
    expect(screen.getByText(/1 via peer ids/)).toBeInTheDocument();
  });

  it('shows Start for a stopped network and calls the backend', async () => {
    primeApi(api, { network: { status: 'stopped' }, nodes: [{ ...ALICE, status: 'stopped' }] });
    api.monitorSnapshot.mockRejectedValue(new Error('no snapshot'));
    api.startNetwork.mockResolvedValue(okOp);
    renderConsole(<Overview />);
    await userEvent.click(await screen.findByRole('button', { name: /Start network/ }));
    expect(api.startNetwork).toHaveBeenCalledWith('net_1');
    expect(screen.getByText('# —')).toBeInTheDocument();
  });

  it('surfaces a failed start operation result', async () => {
    primeApi(api, { network: { status: 'stopped' } });
    api.startNetwork.mockResolvedValue({ ok: false, result: { ...okOp.result, ok: false, error: { code: 'HEALTH_TIMEOUT', message: 'nodes never became healthy' } } });
    renderConsole(<Overview />);
    await userEvent.click(await screen.findByRole('button', { name: /Start network/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nodes never became healthy');
  });

  it('lists live WS events for the selected network', async () => {
    renderConsole(<Overview />);
    await screen.findByText('Network healthy');
    act(() => FakeWebSocket.last().open());
    act(() => pushEvent('node.status', { networkId: 'net_1', nodeId: 'net_1-bob', name: 'demo-bob', status: 'stopping' }));
    expect(await screen.findByText('demo-bob → stopping')).toBeInTheDocument();
  });
});

describe('Node drawer', () => {
  it('opens from the topology with real logs, diagnostics and controls', async () => {
    api.stopNode.mockResolvedValue(okOp);
    renderConsole(
      <>
        <Overview />
        <NodeDrawer />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /demo-alice, Synced/ }));
    const dialog = await screen.findByRole('dialog', { name: 'demo-alice' });
    expect(await within(dialog).findByText(/WARN slow block import/)).toBeInTheDocument();
    expect(within(dialog).getByText('12D3KooWAzAzA')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Restart (planned)' })).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Run diagnostics' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run diagnostics' }));
    expect(within(dialog).getByLabelText('Diagnostics')).toHaveTextContent('RPC reachable');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(api.stopNode).toHaveBeenCalledWith('net_1', 'net_1-alice');
  });

  it('diagnose() derives verdicts only from the sample', () => {
    const checks = diagnose({
      ok: true,
      node: { ...ALICE, expectedPeers: 1 },
      sample: makeSample({ rpc: { reachable: false, error: 'ECONNREFUSED' }, peers: null, health: null }),
      health: makeHealth({ state: 'unavailable', reasons: ['RPC unreachable'] }),
    });
    expect(checks.find((c) => c.l === 'RPC reachable')).toMatchObject({ ok: false, detail: 'ECONNREFUSED' });
    expect(checks.find((c) => c.l === 'Peers connected')).toMatchObject({ ok: false, detail: 'not observed' });
    expect(checks.find((c) => c.l === 'Process running')?.ok).toBe(true);
  });
});
