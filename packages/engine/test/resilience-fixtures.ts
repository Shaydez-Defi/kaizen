/** Shared offline fixtures for the Proof-of-Resilience tests (T-9.x). */

import type { BlockRef, ChainEvidence, ScenarioRunRecord } from '@kaizen/engine';

export const hashOf = (n: number, fork = 0): string => `0x${(n * 16 + fork).toString(16).padStart(64, '0')}`;
export const blockRef = (n: number): BlockRef => ({ number: n, hash: hashOf(n) });

export function fixtureRun(overrides: Partial<ScenarioRunRecord> = {}): ScenarioRunRecord {
  const at = '2026-10-24T00:00:00.000Z';
  return {
    id: 'run-fixture',
    scenarioId: 'scn-1',
    scenarioName: 'pause bob',
    scenarioSchemaVersion: 1,
    snapshot: { id: 'scn-1', name: 'pause bob', schemaVersion: 1, steps: [] },
    networkId: 'net_1',
    networkName: 'demo',
    targetNodes: [],
    requestedBy: 'test',
    replayOfRunId: null,
    state: 'completed',
    currentStepId: null,
    currentStepOrder: null,
    steps: [],
    validation: null,
    warnings: [],
    error: null,
    cleanup: null,
    cancellation: null,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    ...overrides,
  } as unknown as ScenarioRunRecord;
}

export function fixtureEvidence(overrides: Partial<ChainEvidence> = {}): ChainEvidence {
  return {
    version: 1,
    networkId: 'net_1',
    validatorId: 'bob',
    observerNodeId: 'alice',
    genesisHash: hashOf(0),
    faultStartedAt: '2026-10-24T00:00:01.000Z',
    faultEndedAt: '2026-10-24T00:01:00.000Z',
    recoveredAt: '2026-10-24T00:01:12.000Z',
    observations: [
      { phase: 'before-fault', at: '2026-10-24T00:00:00.000Z', best: blockRef(100), finalized: blockRef(98) },
      { phase: 'during-fault', at: '2026-10-24T00:01:00.000Z', best: blockRef(104), finalized: blockRef(98) },
      { phase: 'after-recovery', at: '2026-10-24T00:01:12.000Z', best: blockRef(106), finalized: blockRef(103) },
    ],
    gaps: [],
    metrics: { recovered: true, timeToRecoverMs: 12_000, finalityGapBlocks: 6, blocksMissed: 6, expectedBlockTimeMs: 6_000 },
    ...overrides,
  };
}
