# Phase 3B Report — FailureInjector Foundation (T-3.2)

**Date**: 2026-10-12
**Tasks**: T-3.2 only. Scenario model/authoring (T-3.3/T-3.4), diagnostics,
recovery orchestration (T-4.4), Failure Lab UI, and CLI fault commands
(T-3.6) were explicitly NOT started — this report stops at the injector,
per instruction. The previous report (Phase 3A, T-3.1 fault-mechanism
study) is archived verbatim at `docs/reports/PHASE_03A_REPORT.md`.
**Outcome**: COMPLETE and VERIFIED — the production-quality internal
FailureInjector ships with pause + terminate live-verified against real
`portaldot_dev` nodes; peer-disconnect and partition are registered as
typed-blocked adapters with precise unblock paths (never silently
substituted).

---

## 1. Summary & completed task IDs

- **T-3.2 — FailureInjector with safeguards**: IMPLEMENTED and VERIFIED.

Delivered as one integrated subsystem of the shared engine (no parallel
subsystem): fault domain model + lifecycle machine, narrow typed adapters
(only Phase 3A/R-22-verified mechanisms), the injector with dry-run
default and revalidating execution, SQLite audit trail + typed events,
REST transport, unit tests with real stand-in processes, and a live
integration suite against a disposable two-node network.

## 2. Scope & explicit exclusions

**In scope (T-3.2):**

- `engine.faults` — typed fault operations on `designatedTest` networks
  only (DEC-008), integrated into the existing engine services.
- Mechanisms: `pause` (SIGSTOP/SIGCONT) and `terminate` (engine
  stop/start + restore) fully implemented and verified end-to-end.
- `peer-disconnect` and `partition` registered as blocked adapters
  returning typed `FAULT_NOT_SUPPORTED` results with reasons, evidence
  refs, and unblock paths.
- Dry-run default; explicit `execute()` that revalidates the full safety
  boundary with fresh reads; lifecycle states + enforced transitions;
  separate evidence claims; bounded polling/timeouts; cleanup on every
  path; quarantine + reconcile; redacted, persisted, auditable records;
  typed events.
- REST surface (`preflight`/`dry-run`/`execute`/list/get/cancel/reconcile).

**Explicitly excluded:**

- Failure Lab UI, scenario engine (T-3.3/T-3.4), diagnostics pipeline
  (T-4.x), recovery orchestration (T-4.4), CLI fault commands (T-3.6).
- Privileged (sudo-level) fault execution — deliberately not implemented
  (DEC-018/DEC-019); the engine never escalates privileges.
- Reserved-only topology wiring for peer-disconnect — requires a topology
  change (spawn mode not persisted on NodeConfig); recorded as unblock path.
- Operator-authorization model for kernel-level partition — not implemented.
- No generic shell/signal/executable/host/firewall API — narrow typed
  adapters only.

## 3. Implementation summary

- **Domain model** (`fault/types.ts`, `fault/lifecycle.ts`): 11 states,
  enforced transition table, `FaultExecutionResult` separating claims
  applied / effectObserved / faultRemoved / recovered / recoveryVerified,
  structured before/apply/effect/remove/recovery evidence.
- **Adapters** (`fault/adapter.ts`, `fault/adapters/{pause,terminate,blocked}.ts`):
  each declares mechanism, privileges, preflight checks, bounded execution,
  expected effect, verification method, timeout/failure semantics, cleanup.
  Pause re-verifies pid + `kaizen-node.pid` agreement before signalling
  (ambiguous identity → refused, never signalled). Terminate's removal is
  engine `startNode`; recovery requires a NEW pid answering RPC.
- **Injector** (`fault/injector.ts`): `preflight` (read-only), `dryRun`
  (default, persists), `execute` (revalidates; conflict-atomic), `get`,
  `list`, `cancel`, `reconcile`, `activeFaults`, `shutdown`. Safety gate =
  designatedTest + local chain + node ∈ network + managed-running process +
  stable identity + no active fault + not quarantined + adapter preflight.
  Per-step timeouts use a wrap backstop above each adapter's own bound.
  Cleanup runs on success, error, timeout, and cancel paths; unverified
  cleanup ⇒ `cleanup-failed` + high-severity `fault.cleanup-failed` event +
  quarantine until `reconcile()` proves the effect gone. `engine.close()`
  cancels in-flight faults and SIGCONT-sweeps pause records.
- **Audit** (`state/store.ts`): `faults` table (migrations 6–8,
  schemaVersion 8), every state/transition + preflight/plan/evidence/
  result/error persisted; operations rows (`fault.execute`); key-aware
  redaction on read. `events/bus.ts`: `fault.state`, `fault.cleanup-failed`
  (high severity), flowing through the existing WS fanout.
- **API** (`apps/api/src/server.ts`): Zod-validated fault routes;
  `POST …/faults/execute` requires a literal `mode:"execute"` body marker;
  statusFor maps `FAULT_NOT_ALLOWED`→403, `FAULT_NOT_FOUND`→404,
  `FAULT_CONFLICT`/`FAULT_NOT_SUPPORTED`→409.

## 4. Files changed

- **New**: `packages/engine/src/fault/` (types, lifecycle, redact,
  observer, adapter, injector, adapters/{pause,terminate,blocked}),
  `packages/engine/test/fault.test.ts`,
  `test/integration/faults.int.test.ts`,
  `docs/reports/PHASE_03A_REPORT.md` (archive).
- **Modified**: engine `engine.ts` (faults wiring + shutdown ordering),
  `errors.ts` (4 fault codes), `events/bus.ts`, `index.ts` (exports),
  `state/store.ts` (faults table + CRUD); `apps/api/src/server.ts`
  (routes + statusFor); `packages/engine/test/store.test.ts`
  (schemaVersion 8); docs `ARCHITECTURE`, `DECISIONS` (DEC-019),
  `IMPLEMENTATION_PLAN`, `PROGRESS`, `RISKS` (RSK-25/26/27),
  `TECHNICAL_RESEARCH` (R-22 T-3.2 status), `TESTING` (§11), `README`.

## 5. Architecture & safety decisions

1. **Narrow typed adapters, no generic execution surface** — the engine
   exposes typed fault methods only; there is no API to run arbitrary
   commands, signals, or host-level firewall changes (DEC-019).
2. **Dry-run default; execute is separate and revalidating** — every
   execution re-reads the entire safety boundary (designatedTest/DEC-008,
   chain local, node ownership, running state, stable identity beyond PID
   file agreement, conflicts, quarantine). REST execution additionally
   demands an explicit `mode:"execute"` marker.
3. **No silent mechanism substitution** — unsupported mechanisms fail with
   typed results + unblock paths + R-22 evidence refs; the refuted
   mechanisms (plain reserved-peer RPC, proxy-only cut, static port rules)
   are never used as stand-ins.
4. **Distinct claims, never one success flag** — accepted/applied/
   effect-observed/removed/recovered/recovery-verified are separate,
   each backed by bounded observation (RPC reachability, process table,
   new-pid checks). Unverified rollback ⇒ `cleanup-failed` + quarantine;
   `reconcile()` releases only on proof.
5. **Loopback-trust execution posture** (DEC-019) — REST fault execution
   carries no more power than the existing stop/purge endpoints under the
   same binding model; JSON-only + no CORS blocks browser-page invocation;
   any future non-loopback binding requires an authorization model first
   (RSK-26). No browser-executable host commands exist.
6. **Privileged faults not implemented** — kernel-level mechanisms
   (DEC-018) stay out of the injector until an operator-authorization
   model exists; partition's blocked adapter names that path.

## 6. Mechanism status matrix (with evidence refs)

| Mechanism | Status | Evidence |
|-----------|--------|----------|
| pause (SIGSTOP/SIGCONT) | **VERIFIED — implemented + live re-verified** | R-22 A (`t31-a-full.log`); live `faults.int.test.ts`: test's own 500 ms RPC polling observed the victim unreachable ≥5 s and reachable again; pid unchanged; `chain_getHeader` advanced past the pre-fault head; `outcome=verified` |
| terminate (engine stop/start) | **VERIFIED — implemented + live re-verified** | R-22 D; live: old pid dead, NEW pid serving RPC, `peers>=1` on both nodes, head advanced |
| peer-disconnect | **BLOCKED — adapter registered, typed unsupported result** | R-22 B1/B2: only `--reserved-only` targets disconnect; no topology produces them and spawn mode isn't persisted on NodeConfig. Unblock: reserved-only + proxied-reserved wiring; evidence `t31-b3.log`. Live: REST execute → 409 `FAULT_NOT_SUPPORTED`, victim unaffected |
| partition (C2 unprivileged) | **BLOCKED** | R-22 C2: needs the same reserved-only wiring; `t31-c4.log`/`t31-f6-g` show proxy cut insufficiency and privileged-route behavior. Live: 409, no firewall/netns state touched |
| partition (C4/C5 privileged) | **BLOCKED — NOT IMPLEMENTED by design** | DEC-018 operator authorization + privileged execution path deliberately absent (DEC-019); unblock path recorded on the adapter |

## 7. Commands & actual results (2026-10-12)

```text
npm run typecheck        → PASS (engine, cli, api, web)
npm run lint             → PASS
npm run build            → PASS
npm test                 → PASS: 136/136 tests, 18 files, 68 s
                          (113 prior + 23 new fault unit tests)
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         → PASS: 35/35 tests, 9 files, 268 s
                          (30 prior + 5 new fault live tests)
post-suite hygiene       → 0 orphan portaldot_dev, 0 netns, 0 t31/flt
                          firewall rules (checked); pre-existing stray
                          stub from an earlier session killed (PID 64620)
```

Test counts by layer (kept separate):

- **Unit (no portaldot)**: 23 new in `fault.test.ts` (real stand-in
  `node -e` HTTP-RPC child processes: real signals, real TCP, real pid
  files) + store schemaVersion assertion updated. Total unit 136.
- **Live (real `portaldot_dev 2.0.0`, sha256 `9df4d6332e84…`)**: 5 new in
  `faults.int.test.ts` against a Kaizen-created two-node network
  (`designatedTest === true` asserted at creation). Total live 35.
- **Harness**: the Phase 3A spike (`t31-spike.mjs`) was NOT duplicated or
  reused by the injector — no experiment code in production paths.
- **CLI smoke**: none — no new CLI surface in T-3.2 (T-3.6 owns it).

## 8. Before / during / after observations (live claims)

- **pause**: before — victim `system_health` answering, peers ≥1,
  `chain_getHeader` head H₀, pid P. During — injector executed SIGSTOP;
  the TEST's independent polling (500 ms, 800 ms timeout) recorded a
  continuous unreachable window ≥5 s; process stayed alive. After —
  SIGCONT applied, RPC reachable again, same pid P, head advanced past H₀
  (chain resumed), `result.outcome=verified` with all five claims true.
- **terminate**: before — pid P serving RPC, peers ≥1. During — engine
  `stopNode`; old pid dead (process table check), RPC down; evidence
  `effect.observation.rpcReachable=false`. After — engine `startNode`
  restored a NEW pid P′ answering RPC, peers reconverged ≥1 on both nodes,
  head advanced past the pre-fault head, `recovery.newPid=P′`.
- **REST blocked mechanisms**: against the same live network, execute of
  `peer-disconnect` and `partition` returned HTTP 409
  `FAULT_NOT_SUPPORTED`; victim RPC stayed reachable afterwards (no
  effect, no substitution).
- **Escape**: targeting another network's node through this network →
  `NODE_NOT_FOUND`; the other network's node status stayed `created`.

## 9. Cleanup / rollback evidence (including failure paths)

- Successful pause/terminate runs: cleanup (SIGCONT / engine restore)
  verified on the record itself (`faultRemoved`, `recoveryVerified`) and
  independently by the test.
- Cleanup FAILURE is exercised deliberately (unit): a lying observer that
  can't confirm recovery produces `cleanup-failed`, the high-severity
  event, quarantine of the target (further executes refused), and
  `reconcile()` releasing only when reality shows the effect gone —
  `quarantine kept` vs `quarantine released` notes are asserted.
- Shutdown with an in-flight pause: fault cancelled, process resumed (test
  asserts RPC reachable after `engine.close()` path) — no paused process
  leaks.
- Post-suite: no orphan processes, no netns, no firewall residue.

## 10. Known limitations & unresolved risks

- peer-disconnect/partition remain BLOCKED until topology wiring (spawn
  mode on NodeConfig) and/or an operator-authorization model exist — the
  injector cannot run them and does not pretend to (RSK-24 stays open,
  mitigation updated).
- A cleanup-failed pause requires operator reconciliation (RSK-25);
  quarantine + reconcile + shutdown-sweep mitigate, but a silently
  undelivered SIGCONT still needs a human.
- REST fault execution sits behind the existing loopback-trust model with
  no authentication (RSK-26, DEC-019); equal-or-lesser power than
  stop/purge, browser invocation blocked, but binding beyond loopback
  would require authorization first.
- Fault records accumulate without a retention policy (RSK-27).
- Unit tests use a stand-in node, not `portaldot_dev`; live coverage is 5
  tests on a two-node network (long-horizon holds >60 s not exercised
  live; hold max is enforced and unit-tested).

## 11. Acceptance criteria

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Integrated into shared engine, narrow typed adapters only, no generic exec surface | **PASS** | `engine.faults` wiring; adapter interfaces; no shell/signal/firewall API exists (§3–5) |
| Only R-22-supported mechanisms; unsupported fail typed with reason + unblock, never substituted | **PASS** | blocked adapters; live 409s; unit assertions on `unblock` content (§6) |
| Dry-run default; execute separate + full fresh-read revalidation | **PASS** | gate test incl. identity drift between preflight and execute; REST `mode:"execute"` 400 test |
| Full lifecycle with enforced transitions; no duplicate/concurrent faults | **PASS** | lifecycle truth table test; conflict test → `FAULT_CONFLICT` |
| Separate claims; bounded polling/timeouts; cleanup on all paths | **PASS** | claim/equality assertions; scripted timeout + unobserved-effect + cleanup-throw tests |
| Unverified cleanup ⇒ cleanup-failed + quarantine + high-severity event; reconcile on proof only | **PASS** | cleanup-failure/quarantine/reconcile unit test (lying observer) |
| Structured evidence, redaction, auditable records, typed events, no browser host commands, no sudo | **PASS** | redaction tests; faults table + `fault.state` events; DEC-019 §5 |
| Tests: extensive unit + live only for verified mechanisms (pause, terminate) | **PASS** | 23 unit + 5 live (§7) |
| Gates: typecheck/lint/build/npm test/live integration with honest counts | **PASS** | §7 exact results |
| Docs: research/architecture/plan/progress/testing/risks/decisions/report/README updated | **PASS** | §12 |
| Git hygiene: scoped diff, no secrets/node data, single additive commit | **PASS** (pending commit at time of writing — verified by secret-scan below) | §13 |

## 12. Documentation updates

- `docs/PHASE_REPORT.md` — this report (Phase 3A archived verbatim to
  `docs/reports/PHASE_03A_REPORT.md`).
- `docs/TECHNICAL_RESEARCH.md` — R-22 gains a "T-3.2 implementation
  status" table (implemented/blocked per mechanism with live evidence);
  summary matrix row updated.
- `docs/ARCHITECTURE.md` — §6 fault-injection section rewritten from
  planned to implemented (adapters, safety boundary, lifecycle, claims,
  cleanup); §8 blast-radius gate references the injector enforcement.
- `docs/IMPLEMENTATION_PLAN.md` — T-3.2 → VERIFIED with evidence cells;
  roadmap (T-3.3+) intact.
- `docs/PROGRESS.md` — Phase 3B entry (built, statuses, gates, bugs caught,
  decisions, next step).
- `docs/TESTING.md` — §11 (unit/live layers, commands, results).
- `docs/RISKS.md` — RSK-25/26/27 added; RSK-24 mitigation updated.
- `docs/DECISIONS.md` — DEC-019 (injector boundary + API authorization
  posture).
- `README.md` — Phase 3B status line + engine fault-injection bullet +
  honest "what remains".

## 13. Git diff & hygiene checks

- Files: 16 modified (13 source/test/docs + `README.md` +
  `docs/PHASE_REPORT.md`) and 4 added (`docs/reports/PHASE_03A_REPORT.md`,
  `packages/engine/src/fault/` (9 files), `packages/engine/test/fault.test.ts`,
  `test/integration/faults.int.test.ts`), ~725 insertions in modified files
  plus the new fault module/tests — all task-scoped to T-3.2.
- Secret scan of the diff (node keys, keystore passwords, credentials,
  PEM blocks, machine-specific paths): **clean** — the only key-shaped
  strings are redaction test fixtures (`hunter2` markers) and test
  fixtures under `os.tmpdir()`; no `.kaizen/` state, no captured node
  data, no logs committed (R-22 logs stay in `/tmp/opencode`).
- Additive commit only; no history rewrite; no `docs/PHASE_REPORT.md`
  content lost (archived byte-identical, verified with `diff`).

## 14. Exact next task & remaining roadmap

- **Next**: T-3.3 — scenario model + authoring (ordered actions, delays,
  conditions; CRUD + validation) on top of `engine.faults` +
  `engine.networks`, keeping the same dry-run/gate discipline. Then
  T-3.4 execution, T-3.5 diagnostics/recovery (T-4.4), T-3.6 CLI/UI
  surfaces, T-4 incident timelines, T-5 validator ops, T-6 Docker/K8s
  (P2 wow-factor, stays in scope).
