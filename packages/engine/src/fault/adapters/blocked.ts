/**
 * Blocked adapters (T-3.2) — mechanisms whose Phase 3A envelope cannot yet
 * be reproduced through the engine. They are REGISTERED so requests fail
 * explicitly and auditably (typed unsupported result with the precise
 * unblock path) instead of being silently substituted or ignored.
 *
 * R-22 negative results that must NEVER be substituted for these:
 *  - plain `system_removeReservedPeer` on a normal connection does not sever
 *    the live link (B1: set membership only, 60s/20 samples, twice)
 *  - a per-node proxy cut reconverges around itself (C1: ~1s with mDNS,
 *    ~15s via identify-learned addresses)
 *  - static port-scoped firewall rules are escaped by fresh ephemeral
 *    source ports and IPv6/eth0 legs (C3)
 */

import { KaizenError } from '../../errors';
import {
  DEFAULT_ADAPTER_TIMEOUTS,
  type FaultAdapter,
  type AdapterPreflight,
} from '../adapter';

const NEVER_SUBSTITUTE = `Refused substitution (R-22): plain reserved-peer RPC never severs an established connection, a proxy-only cut reconverges around itself, and static port-scoped firewall rules are escaped by fresh ports.`;

/** Peer disconnect — VERIFIED in R-22 B2 only on `--reserved-only` nodes. */
export const peerDisconnectAdapter: FaultAdapter = {
  type: 'peer-disconnect',
  mechanism:
    'system_removeReservedPeer on a reservation-bound connection (R-22 B2; requires --reserved-only spawn)',
  privileges: 'localhost-rpc',
  reversible: true,
  expectedEffect:
    'the reservation-bound peer link drops at t=0 and stays down (victim rejects the now-unreserved peer)',
  cleanupDescription:
    're-add the captured reserved-peer multiaddr, then verify the peer link returns',
  timeoutBehavior: 'n/a — the adapter refuses execution before any effect is attempted',
  failureBehavior: 'n/a — no fault is ever applied without a passing preflight',
  timeouts: DEFAULT_ADAPTER_TIMEOUTS,

  async preflight(_ctx): Promise<AdapterPreflight> {
    return {
      supported: false,
      reason:
        'peer-disconnect requires a target spawned with --reserved-only (R-22 B2 verified the disconnect only in that configuration). No current Kaizen topology preset produces reserved-only nodes and per-node spawn mode is not persisted on NodeConfig, so the reservation-bound precondition cannot be verified for any engine-managed target today. ' +
        NEVER_SUBSTITUTE,
      unblock:
        'Expose reserved-only wiring in topology presets/custom topologies (persist the spawn mode on NodeConfig so preflight can verify it), then re-run the R-22 B2 envelope through this adapter. Evidence to reproduce: t31-b3.log (removeReservedPeer on --reserved-only node: peers 1→0 at t=0s, sustained 60s).',
      checks: [
        {
          id: 'peer-disconnect.reserved-only-target',
          ok: false,
          detail: 'no engine-managed topology currently yields a --reserved-only node',
        },
      ],
    };
  },

  plan() {
    return [];
  },

  async apply(): Promise<never> {
    throw blocked();
  },

  async verifyEffect(): Promise<never> {
    throw blocked();
  },

  async remove(): Promise<never> {
    throw blocked();
  },

  async verifyRecovery(): Promise<never> {
    throw blocked();
  },
};

/** Partition — R-22 C2 (unprivileged) and C4/C5 (privileged) both blocked. */
export const partitionAdapter: FaultAdapter = {
  type: 'partition',
  mechanism:
    'controlled topology rewiring (R-22 C2) or authorized kernel-level isolation (R-22 C4/C5)',
  privileges: 'privileged-sudo', // the sustained routes need more than we expose today
  reversible: true,
  expectedEffect:
    'the victim loses its peer mesh (peers → 0) while unaffected nodes keep theirs, sustained for the fault window',
  cleanupDescription:
    'restore the cut path (proxy/link/rules) and verify the mesh reconverges',
  timeoutBehavior: 'n/a — the adapter refuses execution before any effect is attempted',
  failureBehavior: 'n/a — no fault is ever applied without a passing preflight',
  timeouts: DEFAULT_ADAPTER_TIMEOUTS,

  async preflight(_ctx): Promise<AdapterPreflight> {
    return {
      supported: false,
      reason:
        'No partition route is reproducible through the engine today. Unprivileged (R-22 C2) needs a --no-mdns --reserved-only victim wired to proxied reserved-nodes — the same missing topology capability as peer-disconnect. Privileged isolation (R-22 C4 ip{,6}tables+cgroup, C5 netns+veth) requires explicit operator authorization (DEC-018) and a privileged execution path that T-3.2 deliberately does not implement — the engine never escalates privileges or touches host firewall state. ' +
        NEVER_SUBSTITUTE,
      unblock:
        'Either (a) reserved-only topology wiring so the C2 envelope runs unprivileged (evidence: t31-c4.log, ≥90s sustained, unaffected mesh intact), or (b) a documented operator-authorization flow with DEC-018 discipline (baseline capture, one-process/one-link scope, both IP families, byte-identical rollback verification — evidence: t31-f6.log, t31-g.log).',
      checks: [
        {
          id: 'partition.unprivileged-route',
          ok: false,
          detail: 'requires reserved-only topology wiring (not producible by any current preset)',
        },
        {
          id: 'partition.privileged-route',
          ok: false,
          detail: 'requires operator authorization + privileged execution path (not implemented by design)',
        },
      ],
    };
  },

  plan() {
    return [];
  },

  async apply(): Promise<never> {
    throw blocked();
  },

  async verifyEffect(): Promise<never> {
    throw blocked();
  },

  async remove(): Promise<never> {
    throw blocked();
  },

  async verifyRecovery(): Promise<never> {
    throw blocked();
  },
};

function blocked(): KaizenError {
  return new KaizenError(
    'FAULT_NOT_SUPPORTED',
    'Fault mechanism is blocked by preflight — no effect was attempted',
  );
}
