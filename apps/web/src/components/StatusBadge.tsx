/** Status + health badges. Every color maps to a real backend state. */

import type { JSX } from 'react';
import type { NetworkStatus, NodeHealthState, NodeStatus } from '../api/types';

const NETWORK_LABEL: Record<NetworkStatus, string> = {
  created: 'Created',
  starting: 'Starting',
  running: 'Running',
  degraded: 'Degraded',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Error',
};

const NODE_LABEL: Record<NodeStatus, string> = {
  created: 'Created',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  crashed: 'Crashed',
  stale: 'Stale',
};

export function StatusBadge({
  status,
  kind = 'network',
}: {
  status: NetworkStatus | NodeStatus;
  kind?: 'network' | 'node';
}): JSX.Element {
  const label = kind === 'network' ? NETWORK_LABEL[status as NetworkStatus] : NODE_LABEL[status as NodeStatus];
  return (
    <span className={`badge badge-${status}`} data-testid={`status-${status}`}>
      {label ?? status}
    </span>
  );
}

const HEALTH_LABEL: Record<NodeHealthState, string> = {
  unknown: 'Unknown',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unavailable: 'RPC unavailable',
  stale: 'Stale data',
};

/** Health badge with the evidence-based reasons in the tooltip. */
export function HealthBadge({
  state,
  reasons,
}: {
  state: NodeHealthState;
  reasons?: string[];
}): JSX.Element {
  const title = reasons && reasons.length > 0 ? reasons.join('; ') : `health: ${state}`;
  return (
    <span className={`badge badge-health-${state}`} title={title} data-testid={`health-${state}`}>
      {HEALTH_LABEL[state]}
    </span>
  );
}

export function HealthBadgeOrUnknown({
  health,
}: {
  health: { state: NodeHealthState; reasons: string[] } | null | undefined;
}): JSX.Element {
  if (!health) return <span className="muted">Unknown</span>;
  return <HealthBadge state={health.state} reasons={health.reasons} />;
}
