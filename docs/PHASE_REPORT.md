# Phase 3E Report — Scenario Replay (T-3.5)

**Date**: 2026-10-18
**Tasks**: T-3.5 only. CLI/UI surfaces for the Failure Lab (T-3.6),
Failure Lab UI, diagnostics (Phase 4), recovery orchestration, and
Kubernetes were explicitly NOT started — this report stops at replay
(engine + API + typed client methods + tests), per instruction. The
previous report (Phase 3D, T-3.4 Scenario Execution Engine) is archived
verbatim at `docs/reports/PHASE_03D_REPORT.md`; Phase 3C/3B/3A remain at
`docs/reports/PHASE_03C_REPORT.md` / `PHASE_03B_REPORT.md` /
`PHASE_03A_REPORT.md`.

## 1. Scope & Exclusions

**In scope (delivered):**

- `ScenarioEngine.replay()` (`engine.scenarioRuns.replay`): re-executes
  a finished run's recorded action sequence (its immutable snapshot) as
  a NEW run through the SAME execution path as `execute()` — same
  pre-execution gates, same FailureInjector pipeline, same evidence,
  cancellation, cleanup, and quarantine semantics. No second executor
  exists anywhere.
- Replay provenance (`replayOfRunId`) persisted in run history
  (new indexed column, schemaVersion 17) and queryable
  (`list({ replayOf })` / `GET /api/scenarios/runs?replayOf=`).
- API route `POST /api/scenarios/runs/:runId/replay` (202) with the
  execute-grade authorization posture (literal `mode: 'execute'` +
  explicitly confirmed target) and an inline `replayNote` stating the
  honest semantics; typed web-client method `replayScenarioRun()`.
- Tests: dedicated engine unit suite, API-layer additions, one new
  LIVE portaldot check; full unit + live regression with exact counts
  below.

**Explicitly out of scope (sequencing boundary, not scope reduction):**

- No CLI commands (T-3.6 owns CLI), no UI/screens (T-3.6 +
  prebuilt-UI integration), no second execution subsystem, no new
  monitoring/diagnostics/recovery/validator workflows, no Kubernetes.
- No authentication work: the replay endpoint inherits DEC-019
  loopback trust + DEC-021 exactly; authenticated non-loopback identity
  remains T-7.3 / RSK-26. No execution surface was exposed remotely.

## 2. Architecture & Replay Contract Decisions

Inspecting the actual T-3.4 implementation (not the report) established
the contract; the notable decisions are recorded as **DEC-022**:

1. **Replay = re-execution from the source run's snapshot via the same
   internal path.** `execute()` was refactored into a shared private
   `startRun(scenario, req, replayOfRunId)`; `execute()` loads the
   CURRENT stored definition, `replay()` loads the SOURCE run and passes
   its immutable `snapshot` record. Gate 1 revalidates that snapshot
   against the CURRENT operation registry (stale capabilities fail
   closed), and every other gate is re-evaluated with current state. If
   the snapshot is unusable (missing/empty steps), replay is refused
   (`SCENARIO_RUN_NOT_REPLAYABLE`) before any run record exists — the
   engine never invents missing values and never substitutes the
   scenario's current definition.
2. **Provenance is not authorization.** The replay request repeats the
   execute posture (`mode: 'execute'` + explicit `networkIdOrName`);
   targets are never inherited from the source run. A historical run is
   audit, not a token.
3. **Eligible source states** (`REPLAYABLE_SCENARIO_RUN_STATES`):
   `completed`, `completed-with-warnings`, `failed`, `cancelled`,
   `cleanup-failed` — terminal execution states only. `rejected` never
   executed an action (the actionable message directs to `execute()`);
   unfinished states are never resumed or replayed (the architecture
   terminalizes interrupted runs first). `cleanup-failed` is allowed
   because the CURRENT quarantine gate decides: an unreconciled target
   is still refused fail-closed; a proven-reconciled one may proceed.
4. **Honesty is structural, not decorative.** `replayOfRunId` on the
   record/summary + `scenarioRunReplayNote()` + the 202 response's
   `replayNote` state "repeats the recorded actions; identical outcomes
   are NOT guaranteed; evidence was freshly observed". The note is NOT
   a `warnings` entry — a clean replay must reach plain `completed`
   exactly like a clean original (a design iteration caught during
   testing: warnings drive `completed-with-warnings`).
5. **Append-only history.** Replay writes only its own row; the source
   run, its snapshot, steps, and evidence are never rewritten. The
   provenance column (`replay_of_run_id`, migration 12, indexed) is set
   once at insert and untouched by updates. Refused gate attempts are
   persisted as `rejected` replay runs WITH provenance (same audit
   posture as `execute()`); pre-run validation refusals (bad request,
   unknown/ineligible source, unusable snapshot) create no phantom rows.

## 3. Files Added / Changed / Removed

**Added:**

- `packages/engine/test/scenario-replay.test.ts` — 10 unit tests.
- `packages/engine/test/scenario-harness.ts` — the real-stand-in-node
  test harness extracted from `scenario-run.test.ts` so both engine
  suites share it (not a vitest suite itself).
- `docs/reports/PHASE_03D_REPORT.md` — the Phase 3D report archived
  verbatim before this overwrite.

**Changed:**

- `packages/engine/src/scenario/runner.ts` — `scenarioReplayRequestSchema`,
  `replay()`, shared `startRun()` (execute + replay), provenance in
  `newRunRecord()`, `replayOf` in the list filter, created-event
  provenance.
- `packages/engine/src/scenario/run-types.ts` — `REPLAYABLE_SCENARIO_RUN_STATES`
  + `isReplayableScenarioRunState()`, `replayOfRunId` on record/summary,
  `scenarioRunReplayNote()`.
- `packages/engine/src/errors.ts` — new code `SCENARIO_RUN_NOT_REPLAYABLE`.
- `packages/engine/src/events/bus.ts` — optional `replayOfRunId` on
  `scenario-run.created`.
- `packages/engine/src/state/store.ts` — migration 12 (ALTER TABLE
  `scenario_runs` + index; schemaVersion 16→17), row/insert/mapping,
  `replayOf` filter in list/count.
- `packages/engine/src/index.ts` — exports.
- `apps/api/src/server.ts` — replay route (202 `{ ok, run, replayNote }`),
  `?replayOf=` query param, `SCENARIO_RUN_NOT_REPLAYABLE` → 409.
- `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts` —
  `replayScenarioRun()`, `ScenarioReplayResponse`, `replayOf` filter.
- `packages/engine/test/scenario-run.test.ts` — imports the extracted
  harness (37 tests unchanged in behavior); reconcile-test helper
  updated for the new record field.
- `packages/engine/test/store.test.ts` — schemaVersion assertion 17.
- `apps/api/test/scenario-runs.test.ts` — 4 new replay tests (9→13).
- `test/integration/scenario-runs.int.test.ts` — 1 new live replay
  check (8→9).
- `docs/PROGRESS.md`, `docs/IMPLEMENTATION_PLAN.md`,
  `docs/ARCHITECTURE.md` (§6 replay contract), `docs/DECISIONS.md`
  (DEC-022), `docs/TESTING.md` (§14).

**Removed:** none (the harness was extracted, not deleted).

## 4. Replay Semantics & Source-Run Provenance

- **Replay repeats ACTIONS; it does not reproduce outcomes.** Chain
  state, node health, peers, timing, finality, and runtime events may
  differ between runs. This is stated in the API response
  (`replayNote`), the client method docs, ARCHITECTURE §6, DEC-022,
  and asserted in tests.
- **No source evidence is reused.** A replay gets its own run id,
  timestamps, step records, fault ids, precondition/postcondition
  verdicts, claims, verification results, and cleanup record; unit and
  live tests assert the new fault ids differ and that the serialized
  replay steps never contain a source fault id.
- **Provenance is queryable in both directions** without corrupting
  history: every run summary exposes `replayOfRunId` (null = original),
  and `?replayOf=<runId>` lists every replay attempt from a source —
  including refused attempts (persisted as `rejected` with
  provenance), which is intentional audit surface.
- **Blocked replays report why they were blocked** (persisted
  `rejected` run with the structured gate error) and never report
  successful execution. Timeout, inconclusive-verification,
  cleanup-failed, and quarantine semantics are the executor's,
  unchanged — covered for replays by dedicated tests.

## 5. API Routes, Request/Response, Authorization

- `POST /api/scenarios/runs/:runId/replay` — body
  `{ mode: 'execute', networkIdOrName, requestedBy? }` (strict Zod
  schema, same conventions as execute). Success: **202**
  `{ ok: true, run, replayNote }` where `run` is the NEW persisted run
  (own id, `replayOfRunId` set, initial state) and `replayNote` states
  the honest contract. Errors: 400 `INVALID_INPUT` (missing marker or
  target / malformed body), 404 `SCENARIO_RUN_NOT_FOUND` (unknown
  source) and `NETWORK_NOT_FOUND` (unresolved target; persisted
  rejected replay), 403 `SCENARIO_EXEC_NOT_ALLOWED` (current gate
  refusal e.g. DEC-008; persisted rejected replay), 409
  `SCENARIO_RUN_NOT_REPLAYABLE` (ineligible state / unusable snapshot)
  and `SCENARIO_RUN_CONFLICT` (concurrent same-scenario/target run).
  Error bodies follow the existing structured envelope; nothing leaks
  secrets (the engine's redaction applies to runs as before).
- `GET /api/scenarios/runs?replayOf=<runId>` — paginated provenance
  query (existing list conventions).
- **Authorization**: DEC-019 loopback trust + DEC-021 exactly —
  read-only GETs never start a replay (test-asserted); execution
  requires the literal marker and an explicit target; authenticated
  non-loopback identity stays deferred to T-7.3 (RSK-26 OPEN).
- **Typed web client**: `replayScenarioRun(runId, { networkIdOrName,
  requestedBy? }) → ScenarioReplayResponse`; `listScenarioRuns` gained
  the `replayOf` filter. No UI screens were built (per instruction).

## 6. Safety Gates & Failure Handling

Replay re-runs the ENTIRE current gate chain through `startRun()`:
fresh snapshot revalidation (RSK-28 posture, now against the CURRENT
registry), operation support (planned/blocked refused — a past success
grants nothing), exact target resolution, DEC-008 (`designatedTest`,
chain scope, preset, `minNodes`, capabilities), label→node resolution,
quarantine (an unreconciled cleanup failure still blocks the target),
and conflict prevention (no concurrent run per scenario/target — a
second replay while one is in flight → 409, test-asserted at both
engine and API level). Every gate refusal persists a `rejected` run
(with `replayOfRunId`) before throwing. Cancellation of a replay goes
through `injector.cancel` with verified rollback; step deadlines report
`STEP_TIMEOUT` with no fault; unconfirmed cleanup remains
`cleanup-failed` + quarantine. T-3.2/T-3.3/T-3.4 safety behavior was
not modified — their suites pass unchanged.

## 7. Exact Commands & Results (2026-10-18)

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm run build` | PASS (exit 0) |
| `npm test` | **PASS — 262/262 tests, 24 files** (engine 195, api 31, web 36) |
| `KAIZEN_TEST_LIVE=1 KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode npm run test:integration` | **PASS — 44/44 tests, 10 files, 336.85 s**, real `portaldot_dev` |
| `… npx vitest run --config vitest.integration.config.mts test/integration/scenario-runs.int.test.ts` (targeted rerun) | PASS — 9/9 (replay check 14.6 s) |
| `pgrep -af portaldot` (after suites) | no processes — no orphans |

## 8. Results by Layer (mocked vs live, reported separately)

- **Engine unit (scripted mechanism doubles + REAL stand-in node
  processes)**: `scenario-replay.test.ts` **10/10**. The 37 T-3.4
  engine tests pass unchanged after the harness extraction
  (`scenario-run.test.ts` 37/37). Scripted coverage is labeled unit and
  is never presented as live evidence.
- **API/persistence (real Fastify + real SQLite, no injector)**:
  `apps/api/test/scenario-runs.test.ts` **13/13** (4 new replay tests);
  `apps/api/test/scenarios.test.ts` 18/18 unchanged.
- **LIVE integration (real portaldot_dev, disposable designated-test
  networks)**: `scenario-runs.int.test.ts` **9/9**, including the new
  replay check: execute a real pause run → replay it with an explicit
  target → the TEST itself independently samples RPC (victim
  unreachable while the replay's fault is held), asserts a fresh fault
  record + fresh claims, re-verifies recovery (same pid, RPC back),
  confirms the source run byte-identical, queries provenance, and
  confirms ineligible/unknown-target refusals execute nothing. Full
  live suite 44/44 with T-3.2/T-3.3/T-3.4 suites intact.

## 9. Acceptance Criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| Replay re-executes the source run's recorded sequence as a NEW run | PASS | unit test 1 (distinct id, snapshot deep-equal, steps order); live replay check |
| Reuses the existing engine + FailureInjector path (no second executor) | PASS | `startRun()` shared by `execute()`/`replay()`; fault records asserted through the injector in unit + live |
| Original run + evidence immutable | PASS | unit byte-identical JSON before/after; live byte-identical check |
| Uses the original snapshot even if the scenario is later edited | PASS | unit test 3 (edited + deleted scenario, snapshot wins) |
| Deleted-scenario replay behavior defined | PASS | unit test 3 (replay works; `execute()` of the deleted scenario throws) |
| Missing/malformed snapshots fail safely | PASS | unit test 3 (empty/absent steps → `SCENARIO_RUN_NOT_REPLAYABLE`, no run created) |
| Ineligible source states rejected | PASS | unit test 3 (`rejected`, unfinished, unknown); API 409 test |
| Explicit target + execution authorization enforced | PASS | unit test 4 (marker/target 400s; unknown/non-designated refusals with provenance); API tests |
| Current safety gates re-evaluated (quarantine, conflicts, unsupported ops) | PASS | unit tests 5–6 (conflict, planted quarantine, planned-op snapshot) |
| Same engine/FailureInjector path, correct sequence, fresh evidence | PASS | unit test 1 (new fault ids, no copied evidence); live check |
| Failure/cancel/timeout/cleanup semantics reused | PASS | unit tests 7–9 (failed-source replay, cancel during hold w/ verified rollback, STEP_TIMEOUT w/ no fault) |
| Read-only requests never execute; duplicate requests prevented | PASS | unit test 10; API duplicate-replay test (exactly one 202 + one 409) |
| API validation/status codes/errors/provenance correct | PASS | API tests 10–13 |
| Replay never claims deterministic outcomes; no source evidence reused | PASS | `replayNote` in 202 + assertions (warnings empty, state `completed`, serialized steps contain no source fault id) |
| Typed web-client method + types added; no UI screens | PASS | `replayScenarioRun` + `ScenarioReplayResponse`; no `.tsx` changes |
| Live replay on a disposable designated-test network, source unchanged, cleanup clean | PASS | live check (9/9 file, 44/44 suite; `pgrep` clean) |
| Full regression green, no tests weakened/deleted | PASS | 262/262 unit; 44/44 live; suites only extended (harness extraction behavior-neutral) |

## 10. Known Limitations, Risks, Deferred Work

- **Loopback-only authorization** on the replay endpoint (DEC-019/021);
  RSK-26 OPEN, T-7.3 owns authenticated non-loopback identity. Nothing
  was exposed remotely.
- **`rejected` runs are intentionally not replayable** (they never
  executed actions) — the actionable error directs to `execute()`.
- **Refused replay attempts are queryable via `?replayOf=`** by design
  (audit); consumers must filter on `state` when they want successful
  replays only.
- **`replayNote` is not yet rendered by any UI** (no UI in this phase);
  T-3.6+ surfaces must show it alongside run provenance.
- **Live replay coverage** exercises a completed pause run end-to-end;
  failed/cancelled/timeout replays are covered by the engine unit
  suite (the execution path is shared, only the source state differs).
- No new risks introduced; RISKS.md unchanged this phase.

## 11. Real Portaldot Infrastructure Exercised?

**Yes.** The live integration suite ran against real `portaldot_dev`
binaries on disposable, Kaizen-created designated-test networks
(DEC-008). The new replay check faulted a real node process (pause via
the injector) twice — once as the source run, once as the replay — with
the effect and recovery independently observed by the test. No
destructive operation touched mainnet or any unapproved network.

## 12. Cleanup & Process Lifecycle

- The replay check re-verifies recovery itself (same pid, RPC back)
  and asserts `engine.faults.activeFaults()` is empty after both runs.
- Full live suite teardown: networks stopped, no orphaned
  `portaldot_dev` processes (`pgrep -af portaldot` after the suites →
  none).
- No secrets/keys/chain data committed; the diff contains only source,
  tests, and docs (pre-commit secret scan clean).

## 13. Remaining Work & Next Task

- **This phase stops after T-3.5** per instruction.
- **Next: T-3.6 — Failure Lab CLI/API and UI integration surfaces.**
  CLI run/replay commands must call `engine.scenarioRuns.execute()` /
  `.replay()` exactly like the API does (no duplicated operation
  logic), and UI wiring must surface run provenance + `replayNote`
  (replay ≠ identical outcome) with real events.
- Roadmap intact: Phase 4 (diagnostics/incident evidence/recovery),
  Phase 5 (validator workflows), Phase 6 (Docker/K8s/Helm), Phase 7
  (security hardening, demo readiness).
