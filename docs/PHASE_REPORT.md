# Phase 3D Report — Scenario Execution Engine (T-3.4)

**Date**: 2026-10-16
**Tasks**: T-3.4 only. Replay (T-3.5), CLI/UI surfaces for the Failure Lab
(T-3.6), Failure Lab UI, diagnostics (Phase 4), recovery orchestration,
and Kubernetes were explicitly NOT started — this report stops at the
backend execution engine + API + tests, per instruction. The previous
report (Phase 3C, T-3.3 Scenario Model & Authoring) is archived verbatim
at `docs/reports/PHASE_03C_REPORT.md`; Phase 3B/3A remain at
`docs/reports/PHASE_03B_REPORT.md` / `PHASE_03A_REPORT.md`.

## 1. Scope & Exclusions

**In scope (delivered):**

- `ScenarioEngine` (`engine.scenarioRuns`): explicit, sequential,
  fully-recorded execution of a validated scenario through the existing
  FailureInjector — pre-execution gate chain, per-step evidence, typed
  failure policies, cancellation/timeout/cleanup, persistent run history,
  crash reconciliation, typed lifecycle events, and a minimal
  server-side REST surface (+ typed web-client methods only).
- Run/step model with explicit states and legal transitions; immutable
  scenario snapshot per run; SQLite run/step persistence with atomic
  transitions and honest malformed-row handling.
- Tests: exhaustive engine unit suite, API-layer suite, and LIVE
  portaldot integration suite; full unit + live regression with exact
  counts below.

**Explicitly out of scope (sequencing boundary, not scope reduction):**

- No replay/deterministic action replay (T-3.5), no CLI commands
  (T-3.6 owns CLI), no Failure Lab UI/screens (T-3.6), no diagnostics or
  recovery orchestration (Phase 4), no Kubernetes (planned scope intact).
- No second execution subsystem: every fault path goes through
  `FailureInjector.preflight/execute/cancel` — the injector's T-3.2
  gates, dry-run→execute discipline, and quarantine semantics are
  unchanged and were not weakened.
- No authentication work: run authorization = DEC-019 loopback trust +
  explicit mode marker + engine gates (new **DEC-021**); authenticated
  non-loopback identity remains T-7.3 / RSK-26.

## 2. Files

**New**

- `packages/engine/src/scenario/runner.ts` — `ScenarioEngine`:
  `execute/get/list/cancel/wait/active/reconcileOnStartup/close`.
- `packages/engine/src/scenario/run-types.ts` — 13 run states / 11 step
  states + legal-transition maps, run/step records, error taxonomy,
  reconcile report, summaries.
- `packages/engine/src/scenario/conditions.ts` — run-time condition
  evaluators (rpc-reachable, process-state, health-state, peers, syncing,
  chain-progress, recovery-verified).
- `packages/engine/test/scenario-run.test.ts` — **37** engine unit tests.
- `apps/api/test/scenario-runs.test.ts` — **9** API unit tests.
- `test/integration/scenario-runs.int.test.ts` — **8** LIVE tests.
- `docs/reports/PHASE_03C_REPORT.md` — 3C archived verbatim (this file
  overwrites `docs/PHASE_REPORT.md`).

**Modified**

- `fault/injector.ts` — `recoverInterrupted()` (execute-mode stuck faults
  → SIGCONT sweep → terminalize → `reconcile()` only on proof; dry-run
  untouched).
- `state/store.ts` — migration 11 (schemaVersion **15**): `scenario_runs`
  + `scenario_run_steps`; run CRUD with atomic transitions; paginated
  list/filter; raw `updateScenario`/`insertFault` helpers.
- `scenario/validate.ts` — `scenarioRecordToInput` exported (run-time
  revalidation of the stored record).
- `errors.ts` — `SCENARIO_RUN_NOT_FOUND` (404), `SCENARIO_RUN_CONFLICT`
  (409), `SCENARIO_EXEC_NOT_ALLOWED` (403), `FAULT_INTERRUPTED`;
  `statusFor` updated.
- `events/bus.ts` — typed `scenario-run.created|state|step|verification|
  cancelled|cleanup-failed|finished`.
- `engine.ts` — wiring (`engine.scenarioRuns`), eager startup reconcile,
  close order (runs → injector → monitoring → store).
- `index.ts` — exports (engine, types, predicates, schemas).
- `apps/api/src/server.ts` — 4 run routes (execute → 202 + run; run
  status; paginated history; cancel), Zod request/query schemas.
- `apps/web/src/api/{client,types}.ts` — typed `executeScenario`,
  `getScenarioRun`, `listScenarioRuns`, `cancelScenarioRun` + response
  types (contract only — no UI).
- `apps/api/test/scenarios.test.ts` (T-3.3 posture updated for T-3.4:
  no implicit-execution/replay routes; execute demands marker + target;
  refusal persists a rejected run) and
  `packages/engine/test/store.test.ts` (schemaVersion 15).
- Docs: `IMPLEMENTATION_PLAN.md` (T-3.4 → VERIFIED), `RISKS.md`
  (RSK-28 → MITIGATED), `ARCHITECTURE.md` (§6 scenario execution),
  `TESTING.md` (§13), `DECISIONS.md` (DEC-021), `PROGRESS.md`.

## 3. Executor Design

**Run lifecycle.** `execute()` parses the request (literal
`mode:"execute"` + explicit target, else 400 before anything exists),
loads the scenario, **persists a run record** (`queued→validating`) and
emits `scenario-run.created` — before any side effect — then evaluates
the gate chain synchronously (no interleaving possible). Gates, in
order, all fail closed and all persist a `rejected` run with a precise
error before throwing:

1. **Fresh revalidation of the STORED definition** (RSK-28) — the
   authoring-time result stored on the row is evidence, never the gate
   (`VALIDATION_FAILED`).
2. **Operation support right now** — blocked/planned operations refused
   even if authoring once accepted them as warnings
   (`UNSUPPORTED_OPERATION`).
3. **Exact target resolution** — unknown network id/name
   (`TARGET_UNRESOLVED`, thrown before a run row exists → clean 404).
4. **DEC-008 safety posture re-checked with fresh reads** —
   `designatedTest`, chain scope (`dev|local-spec`), preset match,
   `minNodes`, capabilities (`GATE_REFUSED`).
5. **Label→managed-node resolution** for every operation and condition
   target (unresolved labels refused).
6. **Quarantine** — an unreconciled `cleanup-failed` fault on any target
   node blocks the run.
7. **Conflicts** — no concurrent run for the same target/scenario; no
   active injector fault on a target node (`CONFLICT`, 409).

**Per-step pipeline** (sequential, one step at a time): persist
`running` → bounded cancel-aware `delayBefore` → **preconditions** (each
with its own authored budget; verdicts `satisfied` / `not-satisfied` /
`inconclusive`, always with observed detail) → **failure policy** →
injector **`preflight`** → **`injector.execute`** (the only fault path)
→ record result + `claims`/evidence → **postconditions** →
**verification** → cleanup verification → persist. Cancellation checked
after preflight so a cancellation during revalidation creates no fault.

**Honesty rules enforced in code and tests:** an exhausted condition
budget is `STEP_TIMEOUT`, never a verdict; missing monitoring data makes
health-state `INCONCLUSIVE`, never a guess; no authored postconditions →
verification `not-required` + `completed-with-warnings`; unconfirmed
cleanup → `cleanup-failed` + high-severity event + quarantine, never
"recovered"; `continue` after a failure additionally requires proof the
target is safe (no active fault, no unreconciled quarantine, no
contradicting claim) or the run fails closed.

**Cancellation / timeout / cleanup.** `cancel(runId)` persists
`cancel-requested` first, then interrupts only via `injector.cancel`
inside a bounded wait; cleanup is attempted on every finish path with a
bounded wait. Step deadline = authored `timeoutMs`; run deadline =
fresh-validation `worstCaseDurationMs`. `close()` cancels in-flight
faults (bounded) before the injector shuts down.

**Durability & crash reconciliation.** Run/step rows are atomic
(single-writer SQLite); history survives reopen with paginated filters
and per-row `SCENARIO_RUN_MALFORMED` entries. On startup,
`reconcileOnStartup()` (idempotent) terminalizes unfinished runs as
`INTERRUPTED` — **never resumes them** — and reconciles stuck
execute-mode faults: SIGCONT sweep → quarantine when recovery cannot be
proven → `reconcile()` releases only on fresh proof.

## 4. API, Events, Authorization

- `POST /api/scenarios/:id/execute` → **202** + run record (or a
  structured 400/403/404/409; refusals leave a persisted `rejected` run
  as audit).
- `GET /api/scenarios/runs/:runId` — full record incl. per-step
  evidence; `GET /api/scenarios/runs` — summaries with
  `scenarioId/networkId/state` filters + `limit/offset/total`;
- `POST /api/scenarios/runs/:runId/cancel` — 200 + run; 409 for
  terminal runs; 404 unknown.
- Typed `scenario-run.*` lifecycle events mirror every state/step/
  verification/cleanup transition (same payload discipline as
  `fault.*`: structured, redacted, no secrets).
- **DEC-021**: authorization = DEC-019 loopback trust + literal
  `mode:"execute"` + explicit target + engine-side fail-closed gates;
  no arbitrary params, no registry bypass, server-side revalidation
  always. The missing authenticated identity control stays visible in
  RSK-26/T-7.3. **No screens were built.**

## 5. Test Results (counts by layer)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 248/248 passed (23 files) — 202 prior + 46 new
                         #   engine 185 (scenario-run 37 new),
                         #   api 27 (scenario-runs 9 new), web 36
KAIZEN_TEST_LIVE=1 KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode \
  npm run test:integration
                         # 43/43 passed (10 files, 317 s) — 35 prior + 8 new
```

- **Engine unit (37)**: state machines (legal/illegal transitions);
  execution core (declared order, one execute-mode fault per step — no
  bypass, immutable snapshot, durability across reopen, exact event
  chain); all 10 gates as persisted refusals with exact error codes and
  **zero fault records**; precondition/postcondition policies incl.
  inconclusive never fabricated; step/run timeouts; cancellation before
  side effects / during the operation / between steps / refuse on
  terminal; cleanup-failure quarantine + proof-gated reconcile; startup
  reconciliation (terminalize-never-resume, quarantine path, idempotency,
  every unfinished state); shutdown.
- **API unit (9)**: execute validation, gate refusals as 4xx + persisted
  rejected runs, full 202→terminal flow via a legitimately skipped run
  (no injector invocation asserted), status/pagination/filters, cancel
  semantics (200/409/404), DEC-019 error posture, and the hard
  guarantee that refusal/skip never emits fault events or records.
- **LIVE (8/8)**, real `portaldot_dev` two-node network, every claim
  independently observed by the test: pause run (unreachable while held →
  same pid + RPC back + head advanced); two sequential steps with
  distinct terminal fault records; precondition abort (node untouched);
  live skip-step then a real execution; cancellation during the hold
  (rollback verified, no leak); STEP_TIMEOUT with zero faults; phantom
  non-designated/`mainnet` targets refused fail-closed; unresolvable
  label refused. Hygiene after the run: no orphaned `portaldot_dev`
  processes (suites assert teardown).
- **T-3.3 verification**: the T-3.3 suites (scenario 32,
  scenario-store 11, api/scenarios 18) re-ran green inside the 248 — no
  T-3.3 defect required fixing; the only T-3.3 test edits were the
  documented schemaVersion bump (10→15) and the API posture test updated
  to its T-3.4 truth (routes now exist, but only with explicit
  marker+target and persisted refusals).
- **CLI smoke**: no new CLI surface in T-3.4 (T-3.6 will call
  `engine.scenarioRuns` exactly like the API does); CLI typecheck/build
  covered by the shared gates.

## 6. Acceptance Criteria

| Requirement | Status | Evidence |
|---|---|---|
| Saved scenario never executes automatically; CRUD/validate/view never fault | MET | API/engine tests: zero fault events/records on authoring paths; execute requires explicit request (DEC-021) |
| Typed run/step states with legal transitions | MET | `run-types.ts` transition maps; state-machine tests |
| Immutable scenario snapshot per run; no secrets in records | MET | snapshot immutability test; redaction test (tampered secret persisted as `[redacted]`) |
| 10 mandatory pre-execution gates, fail closed, run persisted before first side effect | MET | gate chain §3; every gate asserted as a persisted `rejected` run with exact code + zero faults |
| Ordered per-step pipeline through the injector; no bypass | MET | execution-core test (one execute-mode fault per step); live runs |
| Honest inconclusive / timeout outcomes | MET | inconclusive-policy tests; live STEP_TIMEOUT check |
| Failure policies validated at authoring AND run time | MET | policy tests incl. safety-proof requirement for `continue` |
| Cancellation/timeout/cleanup; unconfirmed cleanup → quarantine, never claimed recovered | MET | cancellation + cleanup-failure tests; live cancel check |
| Persistence: atomic transitions, no duplicate/concurrent runs, crash reconciliation without resume | MET | durability + conflict + reconciliation tests (terminalize-never-resume) |
| API: execute/status/history/cancel, typed events, no arbitrary params, no registry bypass, no screens | MET | 9 API tests; typed events; web client methods only |
| Testing: unit + integration + live 8 checks + full regression + CLI smoke where supported | MET | §5 counts (248 unit / 43 live) |
| Docs updated; roadmap intact | MET | §8; IMPLEMENTATION_PLAN unchanged except T-3.4 status |

## 7. Limitations & Risks

- **Authorization** (RSK-26/DEC-021): loopback trust only — equal-or-
  lesser power to the existing stop/purge/fault routes; T-7.3 owns the
  audit/authorization model before any non-loopback exposure.
- **`faultId` appears on a step record after the fault finishes**; an
  in-flight fault is observed through `injector.activeFaults()`/events.
  Adequate for audit (the run record still holds the final id + claims);
  revisit if live UI needs the id mid-flight (T-3.6).
- **One run at a time per target** (by design, conflict-gated) — no
  parallel execution; fine for single-host failure drills.
- **Unproven SIGCONT delivery** still requires operator action
  (RSK-25 residual) — the run honestly ends `cleanup-failed` +
  quarantined rather than assuming recovery.
- **Condition breadth**: health-state depends on monitoring having a
  report (else `inconclusive`); chain-progress 'stalled' needs the
  documented 15 s window; `finality-progress`/`runtime-event` remain
  planned and un-evaluable (rejected at authoring, per DEC-020).
- **RSK-28** is now **MITIGATED** (executor exists and is tested), not
  eliminated: enforcement lives in the engine, so any future execution
  path must go through `engine.scenarioRuns` (DEC-021).

## 8. Documentation

`IMPLEMENTATION_PLAN.md` (T-3.4 → VERIFIED with evidence), `PROGRESS.md`
(2026-10-16 entry: files, gates, problems, next step), `ARCHITECTURE.md`
(§6 scenario execution properties), `TESTING.md` (§13 with exact
commands/counts), `RISKS.md` (RSK-28 → MITIGATED with residual),
`DECISIONS.md` (DEC-021), this report (3C archived verbatim at
`docs/reports/PHASE_03C_REPORT.md`).

## 9. Hygiene

- New tests are real-data tests (real SQLite/EventBus/injector/real
  stand-in processes; live tests use disposable designated-test networks
  only); no orphaned processes or netns/iptables leftovers after runs.
- No secrets, keys, or machine-specific paths committed; `.kaizen/`
  ignored; add-only changes (additive commits; no history rewrite).
- No fabricated data anywhere: every UI/CLI/API field served is real
  persistence or real observation; unimplemented surfaces (replay,
  screens, CLI run commands) are absent, not faked.

## 10. Confirmation: execution cannot happen outside the gates

The ONLY code path that starts a fault from a scenario is
`ScenarioEngine → injector.preflight → injector.execute`. There is no
second executor, no raw-process path, no shell surface, and no API
parameter that reaches the injector other than the validated run request.
Authoring remains execution-free (T-3.3 guarantees re-asserted by the
updated API tests). Every refusal — including malformed requests and
gate failures — either never reaches the engine or persists a
`rejected` run before throwing; a rejected/skipped/cancelled run has
`faultId: null` and leaves zero fault records.

## 11. Next Task

**STOP after T-3.4** per instruction. Roadmap order when resumed:
**T-3.5 Replay** — must reuse `engine.scenarioRuns.execute()` and never
introduce a second executor; replay semantics must state
replay ≠ identical-outcome. Failure Lab UI, CLI surfaces, diagnostics,
and Kubernetes remain planned and untouched.
