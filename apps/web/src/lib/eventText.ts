/**
 * Human text for REAL engine events (T-3.6B). Pure formatting of payload
 * fields the engine emitted — nothing is inferred or invented.
 */

import type { StoredEvent } from '../state/EventsContext';

export type EventLevel = 'ok' | 'warn' | 'bad' | 'dim';

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function eventLevel(e: StoredEvent): EventLevel {
  const p = e.payload;
  if (e.name.endsWith('cleanup-failed') || e.name === 'monitor.error') return 'bad';
  const to = s(p['to']) ?? s(p['status']) ?? s(p['state']);
  if (to && /failed|crashed|unhealthy|unavailable|rejected/.test(to)) return 'bad';
  if (to && /executing|paused|stopping|degraded|stale|cancel/.test(to)) return 'warn';
  if (e.name.startsWith('fault.')) return 'warn';
  if (e.name === 'monitor.sample' || e.name === 'rpc.sample' || e.name === 'monitor.peers') return 'dim';
  return 'ok';
}

export function eventText(e: StoredEvent): string {
  const p = e.payload;
  const who = s(p['nodeName']) ?? s(p['name']) ?? s(p['nodeId']) ?? s(p['networkId']) ?? '';
  switch (e.name) {
    case 'network.created':
      return `Network ${s(p['name']) ?? who} created`;
    case 'network.status':
      return `Network → ${s(p['status']) ?? '?'}`;
    case 'node.status':
      return `${who} → ${s(p['status']) ?? '?'}`;
    case 'monitor.health':
      return `${who} health → ${s(p['state']) ?? s(p['to']) ?? '?'}`;
    case 'fault.state':
      return `${s(p['type']) ?? 'fault'} on ${who}: ${s(p['from']) ?? '?'} → ${s(p['to']) ?? '?'}`;
    case 'fault.cleanup-failed':
      return `Fault cleanup failed on ${who}`;
    case 'operation.completed':
      return `${s(p['kind']) ?? 'operation'} ${p['ok'] === false ? 'failed' : 'completed'}`;
    case 'scenario-run.created':
      return `Run ${s(p['runId']) ?? ''} created (${s(p['scenarioName']) ?? 'scenario'})`;
    case 'scenario-run.state':
      return `Run ${s(p['runId']) ?? ''}: ${s(p['from']) ?? '?'} → ${s(p['to']) ?? '?'}`;
    case 'scenario-run.step':
      return `Step ${s(p['stepId']) ?? ''}: ${s(p['to']) ?? '?'}`;
    case 'scenario-run.finished':
      return `Run ${s(p['runId']) ?? ''} finished: ${s(p['state']) ?? '?'}`;
    case 'v3.anchor':
      return `V3 anchor ${s(p['method']) ?? ''} → ${s(p['status']) ?? '?'}${typeof p['blockNumber'] === 'number' ? ` (#${p['blockNumber']})` : ''}`;
    default:
      return who ? `${e.name} · ${who}` : e.name;
  }
}

/** Events that matter to a human timeline (drops high-frequency samples). */
export function isNotable(e: StoredEvent): boolean {
  return !['monitor.sample', 'rpc.sample', 'monitor.peers'].includes(e.name);
}

export function eventTime(e: StoredEvent): string {
  const d = new Date(e.at);
  const t = Number.isNaN(d.getTime()) ? new Date(e.receivedAt) : d;
  return t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
