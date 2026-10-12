# Phase 3A Report — Fault Mechanism Feasibility Study (T-3.1)

**Date**: 2026-10-12
**Tasks**: T-3.1 only (Phase 3A split from Phase 3; the FailureInjector
T-3.2 and scenario engine T-3.3/T-3.4 were explicitly NOT started — this
report stops at the study, per instruction). The previous report (Phase 2B)
is archived at `docs/reports/PHASE_02B_REPORT.md`.
**Outcome**: COMPLETE — the capability matrix is documented in
`docs/TECHNICAL_RESEARCH.md` **R-22** with per-mechanism statuses, and every
VERIFIED claim traces to a recorded experiment log. Negative results (three
mechanisms that do **not** work as hoped) are recorded with the same rigor.

---

## 1. Summary & completed task IDs

Kaizen now knows, with evidence, which failure mechanisms are inducible on
a single host and how to prove them:

| Mechanism | Best proven route | Status |
|-----------|-------------------|--------|
| Pause/resume | SIGSTOP/SIGCONT on the managed PID | **VERIFIED** |
| Terminate + restart | engine stop/start (health ≠ pause) | **VERIFIED** |
| Peer disconnect | `removeReservedPeer` on a `--reserved-only` node | **VERIFIED (conditional)** |
| Partition (unprivileged) | reserved-only victim + proxied reserved-nodes | **VERIFIED (≥90 s)** |
| Partition (privileged, authorized) | ip{,6}tables + cgroup process scoping, or netns + veth | **VERIFIED** |
| Reserved-peer RPC on normal conns | — (cannot sever live connections) | PARTIALLY VERIFIED (negative) |
| Proxy cut alone / static port rules | — (mesh reconverges / rules escape) | PARTIALLY VERIFIED (negative) |

All experiments used freshly created disposable Kaizen-managed networks;
`designatedTest === true` was verified before every fault (DEC-008 intact).
Privileged experiments (iptables/netns) ran only after **explicit operator
authorization** and follow the new DEC-018 discipline (narrow scope,
baseline capture, byte-identical rollback verification).

## 2. Evidence

- **Capability matrix** (mechanism, approach, privileges, scope,
  induced-successfully, evidence, recovery, cleanup, limitations, status):
  `docs/TECHNICAL_RESEARCH.md` → **R-22**, including the environment facts
  any injector must respect (mDNS default-on, ephemeral outbound ports,
  dual-stack + eth0 legs, inert `--ctdir`, unsupported `--pid-owner`,
  effective `--ctstate NEW` + `-m cgroup --path`, EBUSY cgroup move-back).
- **Harness**: `test/experiments/t31-spike.mjs` (argv-only spawns,
  designatedTest gate, SIGSTOP registry + firewall/netns/cgroup rollback on
  every exit path, emergency cleanup).
- **Raw logs**: `/tmp/opencode/t31-*.log` (a/b/c/f/g/d runs cited per row in
  R-22 and `docs/TESTING.md` §10).
- **Gates (all green)**: `npm run typecheck` ✅ · `npm run lint` ✅ ·
  `npm run build` ✅ · `npm test` ✅ 113/113 (17 files) ·
  `KAIZEN_TEST_LIVE=1 npm run test:integration` ✅ 30/30 (8 files, real
  `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu`).

## 3. Honest limitations & verification boundary

- "Partition succeeded" is only claimed where the connectivity change **and**
  unaffected-node connectivity were both observed (peer sets on every node +
  `ss` + head/finality progression) — never from the target's silence.
- Health values cited are **direct RPC reads**; no monitor/UI behavior
  during faults is claimed.
- Three mechanisms are recorded as partial *negative* results: the
  reserved-peer RPC does not disconnect normal connections; a bare proxy cut
  reconverges (~1 s with mDNS, ~15 s with `--no-mdns`); static port-scoped
  iptables isolates only until the victim redials (fresh ephemeral port,
  IPv6 loopback, eth0 legs — all observed).
- One firewall-leak incident occurred mid-spike (malformed `-D` left rules);
  it was detected by the harness's own final-state check, cleaned manually
  (verified empty), and fixed (exact `-D` + logged delete failures). This
  incident is why DEC-018 mandates rollback verification.
- Not measured: windows >90 s, partial-authority finality under isolation
  (RSK-12 stays open), non-nft firewall backends/other kernels.

## 4. Documentation updated

- `docs/TECHNICAL_RESEARCH.md` — R-22 entry + summary-matrix rows (R-21/R-22).
- `docs/DECISIONS.md` — DEC-018 (kernel-level fault operations).
- `docs/IMPLEMENTATION_PLAN.md` — T-3.1 → VERIFIED with evidence pointer.
- `docs/PROGRESS.md` — full Phase 3A entry (files, commands, results,
  problems, decisions, next step).
- `docs/TESTING.md` — §10 (experiment table, reproduction commands, gates,
  verification boundary).
- `docs/RISKS.md` — RSK-09 → MITIGATED; RSK-24 added (injector bypass via
  discovery/address leakage; design constraints proven).
- `docs/ARCHITECTURE.md` — §6 fault-injection lifecycle note (T-3.2
  guidance under DEC-008/DEC-018).
- This report; Phase 2B report archived to `docs/reports/PHASE_02B_REPORT.md`.

## 5. Remaining work / next step

- Stop here per instruction. NOT started: FailureInjector (T-3.2), scenario
  model/engine (T-3.3/T-3.4), Failure Lab UI, incident timelines (Phase 4),
  validator transactions (Phase 5), Docker/K8s (Phase 6).
- **Next action**: T-3.2 — build the FailureInjector using R-22's
  unprivileged defaults (SIGSTOP, engine stop/start, reserved-only+proxy)
  and DEC-018's discipline for any kernel-level fault, with the DEC-008
  gate, dry-run preview, timeouts, guaranteed cleanup, and per-fault
  logging (actor/target/result). Each mechanism chosen for the injector
  gets re-verified inside the injector's own lifecycle (unit tests for the
  gate; live integration evidence for at least one fault + recovery).
