// @vitest-environment jsdom
/** Failure Lab + Scenarios (T-3.6B): explicit confirm, real API calls, honest blocked states. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-utils/render';
import { ApiError, apiClient } from '../api/client';
import type { FaultRecord, ScenarioRecord, ScenarioRunRecord, ScenarioRunSummary } from '../api/types';
import { Lab } from './Lab';
import { Scenarios, draftFromRecord, inputFromDraft } from './Scenarios';
import { primeApi, type ApiMock } from '../test-utils/mockApi';
import { renderConsole } from '../test-utils/renderConsole';

vi.mock('../api/client', async (orig) => {
  const actual = await orig<typeof import('../api/client')>();
  const { makeApiMock } = await import('../test-utils/mockApi');
  return { ...actual, apiClient: makeApiMock() };
});
const api = apiClient as unknown as ApiMock;

const claims = { applied: true, effectObserved: true, faultRemoved: true, recovered: true, recoveryVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  primeApi(api);
});

describe('Failure Lab', () => {
  it('shows blocked mechanisms disabled and requires confirm before executing', async () => {
    api.executeFault.mockResolvedValue({
      ok: true,
      result: { ok: true, outcome: 'verified', faultId: 'flt-1', state: 'completed', networkId: 'net_1', nodeId: 'net_1-alice', type: 'pause', claims, evidence: {}, durationMs: 14_000 },
    });
    renderConsole(<Lab />, { route: '/lab' });
    await screen.findByText('Break it on purpose');
    const kinds = screen.getByRole('group', { name: 'Fault type' });
    expect(within(kinds).getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(within(kinds).getByRole('button', { name: 'Partition' })).toBeDisabled();
    await userEvent.click(within(screen.getByRole('group', { name: 'Hold duration' })).getByRole('button', { name: '30s' }));
    await userEvent.click(screen.getByRole('button', { name: /Inject fault/ }));
    expect(api.executeFault).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Confirm fault' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Inject fault/ }));
    expect(api.executeFault).toHaveBeenCalledWith('net_1', { nodeId: 'net_1-alice', type: 'pause', options: { durationMs: 30_000 }, requestedBy: 'web' });
    expect(await screen.findByText('Recovery verified')).toBeInTheDocument();
    expect(screen.getByLabelText('Last result')).toHaveTextContent('Recovery independently verified');
  });

  it('renders a refused dry-run preflight from the 403 body', async () => {
    api.dryRunFault.mockRejectedValue(
      new ApiError('Request failed with HTTP 403', 'HTTP_403', 403, {
        ok: false,
        preview: { preflight: { ok: false, checks: [{ id: 'target.designated-test', ok: false, detail: 'not a test network' }], blockingReasons: ['Network is not designated test'] } },
      }),
    );
    renderConsole(<Lab />, { route: '/lab' });
    await userEvent.click(await screen.findByRole('button', { name: 'Dry run' }));
    const box = await screen.findByLabelText('Dry-run preflight');
    expect(box).toHaveTextContent('refused');
    expect(box).toHaveTextContent('target.designated-test');
    expect(box).toHaveTextContent('Network is not designated test');
  });

  it('follows an active fault and rolls it back via cancel', async () => {
    const active = { id: 'flt-live', networkId: 'net_1', nodeId: 'net_1-bob', nodeName: 'demo-bob', type: 'pause', mode: 'execute', state: 'executing', requestedBy: 'cli', requestedAt: '', updatedAt: '' } as FaultRecord;
    primeApi(api, { faults: [active] });
    api.cancelFault.mockResolvedValue({ ok: true });
    renderConsole(<Lab />, { route: '/lab' });
    expect(await screen.findByText('demo-bob under pause')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Roll back now/ }));
    expect(api.cancelFault).toHaveBeenCalledWith('flt-live');
  });
});

const scenario = {
  id: 'scn-1',
  name: 'pause-alice-drill',
  description: '',
  schemaVersion: 1,
  tags: [],
  requires: { designatedTest: true, preset: 'two-node' },
  steps: [
    { id: 'pause-alice', order: 0, operation: { type: 'pause', config: { node: 'alice', durationMs: 10_000 } }, delayBeforeMs: 0, delayAfterMs: 0, timeoutMs: 180_000, preconditions: [], postconditions: [] },
  ],
  execution: {},
  validation: { valid: true, schemaVersion: 1, issues: [], errorCount: 0, warningCount: 0, worstCaseDurationMs: 180_000, stepCount: 1 },
  validationStatus: 'valid',
  createdBy: 'test',
  updatedBy: 'test',
  createdAt: '',
  updatedAt: '',
} as unknown as ScenarioRecord;

const summary = {
  id: 'run-old',
  scenarioId: 'scn-1',
  scenarioName: 'pause-alice-drill',
  networkId: 'net_1',
  networkName: 'demo',
  state: 'completed',
  currentStepId: null,
  currentStepOrder: null,
  stepCount: 1,
  completedSteps: 1,
  requestedBy: 'cli',
  replayOfRunId: null,
  warnings: 0,
  error: null,
  cancellation: null,
  createdAt: '',
  startedAt: '',
  finishedAt: '',
} as ScenarioRunSummary;

describe('Scenarios', () => {
  it('builds evidence-carrying input from a draft', () => {
    const input = inputFromDraft(draftFromRecord(scenario), 'two-node', []);
    expect(input.requires).toEqual({ designatedTest: true, preset: 'two-node' });
    expect(input.steps[0]).toMatchObject({
      operation: { type: 'pause', config: { node: 'alice', durationMs: 10_000 } },
      timeoutMs: 180_000,
      preconditions: [{ kind: 'rpc-reachable', node: 'alice', expect: true }, { kind: 'process-state', node: 'alice', expect: ['running'] }],
      postconditions: [{ kind: 'recovery-verified', node: 'alice' }, { kind: 'rpc-reachable', node: 'alice', expect: true }],
    });
    expect(inputFromDraft(draftFromRecord(scenario), 'custom', []).requires).toEqual({ designatedTest: true });
  });

  it('saves then executes against the selected network after confirm', async () => {
    api.listScenarios.mockResolvedValue({ ok: true, scenarios: [scenario], malformed: [], total: 1, limit: 50, offset: 0 });
    api.updateScenario.mockResolvedValue({ ok: true, scenario });
    const run = { id: 'run-new', state: 'running', steps: [{ stepId: 'pause-alice', order: 0, operationType: 'pause', nodeLabel: 'alice', state: 'running' }], currentStepId: 'pause-alice', error: null } as unknown as ScenarioRunRecord;
    api.executeScenario.mockResolvedValue({ ok: true, run });
    api.cancelScenarioRun.mockResolvedValue({ ok: true, run: { ...run, state: 'cancel-requested' } });
    renderConsole(<Scenarios />, { route: '/scenarios' });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('pause-alice-drill'));
    await userEvent.click(screen.getByRole('button', { name: /Run scenario/ }));
    expect(api.executeScenario).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Confirm run' })).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.executeScenario).toHaveBeenCalledWith('scn-1', { networkIdOrName: 'net_1', requestedBy: 'web' }));
    expect(api.updateScenario).toHaveBeenCalled();
    expect(await screen.findByLabelText('Current run')).toHaveTextContent('Step 1/1: pause alice · running');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(api.cancelScenarioRun).toHaveBeenCalledWith('run-new', 'web');
  });

  it('replays a finished run and links completed runs to V3 anchoring', async () => {
    api.listScenarioRuns.mockResolvedValue({ ok: true, runs: [summary], malformed: [], total: 1, limit: 10, offset: 0 });
    api.replayScenarioRun.mockResolvedValue({ ok: true, run: { id: 'run-replay', state: 'queued', steps: [], currentStepId: null, error: null }, replayNote: 'x' });
    renderConsole(<Scenarios />, { route: '/scenarios' });
    const history = await screen.findByLabelText('Run history');
    await waitFor(() => expect(within(history).getByText('pause-alice-drill')).toBeInTheDocument());
    expect(within(history).getByRole('button', { name: 'Anchor' })).toBeInTheDocument();
    await userEvent.click(within(history).getByRole('button', { name: 'Replay' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Confirm run' })).getByRole('button', { name: 'Replay' }));
    expect(api.replayScenarioRun).toHaveBeenCalledWith('run-old', { networkIdOrName: 'net_1', requestedBy: 'web' });
  });

  it('disables operations the engine registry reports as blocked', async () => {
    api.scenarioOperations.mockResolvedValue({
      ok: true,
      operations: [
        { type: 'pause', displayName: 'Pause', status: 'supported', supportedPreconditions: ['rpc-reachable', 'process-state'], supportedPostconditions: ['recovery-verified', 'rpc-reachable'] },
        { type: 'partition', displayName: 'Partition', status: 'blocked', statusReason: 'R-22', supportedPreconditions: [], supportedPostconditions: [] },
      ],
    });
    renderConsole(<Scenarios />, { route: '/scenarios' });
    const option = await screen.findByRole('option', { name: /Partition \(not available\)/ });
    expect(option).toBeDisabled();
  });
});
