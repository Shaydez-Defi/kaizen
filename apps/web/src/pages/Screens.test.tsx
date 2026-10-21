// @vitest-environment jsdom
/** Create / Validators / Incidents / Deployments / Settings (T-3.6B). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-utils/render';
import { apiClient } from '../api/client';
import type { FaultRecord } from '../api/types';
import { Create } from './Create';
import { Validators } from './Validators';
import { Incidents, faultTimeline } from './Incidents';
import { Deployments } from './Deployments';
import { Settings } from './Settings';
import { okOp, primeApi, type ApiMock } from '../test-utils/mockApi';
import { renderConsole } from '../test-utils/renderConsole';

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

const fault = {
  id: 'flt-done',
  networkId: 'net_1',
  nodeId: 'net_1-alice',
  nodeName: 'demo-alice',
  type: 'pause',
  mode: 'execute',
  state: 'completed',
  requestedBy: 'web',
  requestedAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:20.000Z',
  finishedAt: '2026-10-21T10:00:20.000Z',
  holdDurationMs: 10_000,
  evidence: {
    before: { at: '2026-10-21T10:00:01.000Z', rpcReachable: true, head: { hash: '0x', number: 50 } },
    applied: { at: '2026-10-21T10:00:02.000Z', how: 'SIGSTOP pid 4242' },
    effect: { observed: true, attempts: 1, detail: 'RPC timed out while paused', observation: { at: '', rpcReachable: false }, at: '2026-10-21T10:00:03.000Z' },
    removed: { at: '2026-10-21T10:00:12.000Z', how: 'SIGCONT pid 4242' },
    recovery: { verified: true, attempts: 2, detail: 'head advanced to #53', observation: null, at: '2026-10-21T10:00:15.000Z' },
    notes: [],
  },
  result: { ok: true, outcome: 'verified', claims: { applied: true, effectObserved: true, faultRemoved: true, recovered: true, recoveryVerified: true } },
} as unknown as FaultRecord;

describe('Create', () => {
  it('slugifies the name, creates then starts via the API', async () => {
    api.createNetwork.mockResolvedValue({ ok: true, network: { id: 'net_9' } });
    api.startNetwork.mockResolvedValue(okOp);
    renderConsole(<Create />, { route: '/create' });
    const input = screen.getByLabelText('Network name');
    await userEvent.clear(input);
    await userEvent.type(input, 'My Demo Net');
    expect(screen.getByText(/Will be created as “my-demo-net”/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /4 validator/ }));
    await userEvent.click(screen.getByRole('button', { name: /Create network/ }));
    await waitFor(() => expect(api.createNetwork).toHaveBeenCalledWith({ name: 'my-demo-net', preset: 'four-validator' }));
    await waitFor(() => expect(api.startNetwork).toHaveBeenCalledWith('net_9'));
  });

  it('builds a custom topology input from the steppers', async () => {
    api.createNetwork.mockResolvedValue({ ok: true, network: { id: 'net_c' } });
    renderConsole(<Create />, { route: '/create' });
    await userEvent.click(screen.getByRole('button', { name: /Custom/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Start after create' }));
    await userEvent.click(screen.getByRole('button', { name: /Create network/ }));
    await waitFor(() => expect(api.createNetwork).toHaveBeenCalled());
    const arg = api.createNetwork.mock.calls[0]![0] as { custom: { nodes: { role: string }[] } };
    expect(arg.custom.nodes.map((n) => n.role)).toEqual(['validator', 'validator', 'full']);
    expect(api.startNetwork).not.toHaveBeenCalled();
  });
});

describe('Validators', () => {
  it('lists real validators and labels staking as Phase 5', async () => {
    renderConsole(<Validators />, { route: '/validators' });
    const table = await screen.findByRole('table', { name: 'Validators' });
    expect(within(table).getByText('//alice')).toBeInTheDocument();
    expect(within(table).getByText('//bob')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bond' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rotate keys' })).toBeDisabled();
    expect(screen.getAllByText(/Phase 5/).length).toBeGreaterThan(0);
  });
});

describe('Incidents', () => {
  it('labels detection as Phase 4 and shows the empty state without evidence', async () => {
    renderConsole(<Incidents />, { route: '/incidents' });
    expect(await screen.findByText('No fault evidence yet')).toBeInTheDocument();
    expect(screen.getByText(/Phase 4/)).toBeInTheDocument();
  });

  it('renders recorded fault evidence as a timeline', async () => {
    primeApi(api, { faults: [fault] });
    renderConsole(<Incidents />, { route: '/incidents' });
    expect(await screen.findByText(/Applied: SIGSTOP pid 4242/)).toBeInTheDocument();
    expect(screen.getByText('Verified independently over RPC.')).toBeInTheDocument();
    expect(faultTimeline(fault).map((e) => e.msg.split(':')[0])).toEqual([
      'pause requested on demo-alice by web',
      'Before',
      'Applied',
      'Effect observed',
      'Removed',
      'Recovery verified',
      'Finished',
    ]);
  });
});

describe('Deployments', () => {
  it('shows real local processes and Docker/Kubernetes as Phase 6', async () => {
    renderConsole(<Deployments />, { route: '/deployments' });
    expect(await screen.findByText('Running as local processes')).toBeInTheDocument();
    const seg = screen.getByRole('group', { name: 'Deployment target' });
    expect(within(seg).getByRole('button', { name: 'Docker' })).toBeDisabled();
    expect(within(seg).getByRole('button', { name: 'Kubernetes' })).toBeDisabled();
    expect(screen.getByText(/pid 4242/)).toBeInTheDocument();
    expect(screen.getByText(/Phase 6/)).toBeInTheDocument();
  });
});

describe('Settings', () => {
  it('reports real readiness and removes a network only after confirm', async () => {
    api.removeNetwork.mockResolvedValue({ ok: true, removed: 'net_1' });
    renderConsole(<Settings />, { route: '/settings' });
    expect(await screen.findByText(/kaizen-api v0.1.0/)).toBeInTheDocument();
    expect(await screen.findByText(/portaldot 1.0.0/)).toBeInTheDocument();
    expect(screen.getByText('/data/.kaizen')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(api.removeNetwork).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove network?' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.removeNetwork).toHaveBeenCalledWith('net_1'));
    expect(await screen.findByText('Removed demo.')).toBeInTheDocument();
  });

  it('flags a missing binary as action needed', async () => {
    api.binaries.mockResolvedValue({ ok: true, status: { available: false, error: 'binary not found' } });
    renderConsole(<Settings />, { route: '/settings' });
    expect(await screen.findByText('binary not found')).toBeInTheDocument();
    expect(screen.getAllByText('Action needed').length).toBeGreaterThan(0);
  });
});
