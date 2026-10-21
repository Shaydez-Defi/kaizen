# Phase 3F Report (partial) — Failure Lab CLI/API Integration (T-3.6A)

**Date**: 2026-10-21 · **Status**: IMPLEMENTED & VERIFIED (this slice)
· Prior report archived verbatim as `docs/reports/PHASE_08A_REPORT.md`.

## 1. Task & scope

T-3.6A ONLY: the operator-facing CLI surface for Failure Lab scenarios
and runs (authoring, execution, replay, inspection, cancellation) plus
an audit of the API surface. Explicitly out of scope for this slice:
the web-UI integration surface (T-3.6B — imported UI wiring), Phase 4,
contracts/registry/wallet, K8s/Helm, Phases 5–7. T-3.6 as a whole
remains PARTIAL until the UI flow exists.

Constraints honored: the CLI calls the shared engine (`packages/engine`)
— never a second executor, never a re-implementation of gates, target
validation, preconditions, cancellation, timeout, or cleanup; no
destructive operation can reach a non-designated-test network (DEC-008
gates stay engine-side); audit history and source-run immutability
preserved; no new dependencies; the API needed **zero changes** (audit
below).

## 2. Architecture & files changed

- `packages/cli/src/program.ts` (NEW): the whole CLI program —
  `kaizen scenario (list | get <id> | create <file> | validate <file> |
  operations)` and `kaizen run (execute <scenarioId> | replay <runId> |
  list | get <runId> | cancel <runId>)`. `execute`/`replay` require
  explicit `-n, --network <idOrName>` (never inferred) and accept
  bounded `--timeout <ms>` (default 300000; cancel 60000). Structured
  errors + exit codes per DEC-024; rejected runs are surfaced with their
  persisted id and an actionable hint. `buildProgram(deps?)` exposes an
  engine-factory DI seam used by tests only.
- `packages/cli/src/index.ts`: rewritten as the thin bin wrapper
  (parse + version/help conventions only).
- `packages/cli/test/scenario-commands.test.ts` (NEW): 36 offline unit
  tests (parsing/help/validation/JSON/exit codes/timeout & cancel
  honesty/rejected-run surfacing) — mocked engine, never live claims.
- `test/integration/cli-scenario.int.test.ts` (NEW): 5 LIVE tests
  against a real `portaldot_dev` network (see §5).
- Engine (cross-process run control, DEC-025 — every fix driven by a
  real observed failure):
  - `packages/engine/src/fault/adapters/pause.ts`: `nodeAlive()`
    liveness rule (fresh running record + live OS pid) replacing the
    in-memory-only view at 5 sites.
  - `packages/engine/src/scenario/runner.ts`: durable cross-process
    cancel (`cancel()` persists for any non-terminal run — still no
    second executor); memoizing `cancelPending()` at every checkpoint;
    a 400ms single-interrupt watcher around the in-flight fault honoring
    the persisted request via the same `faults.cancel` mechanism;
    pending-cancellation-honored recording (an interrupted fault that
    ends failed/rejected records the step/run `cancelled`, never a
    misattributed failure; `cleanup-failed` still quarantines);
    `executor_pid` stamped once at insert; startup reconcile defers to
    live owners.
  - `packages/engine/src/state/store.ts`: migration #13
    (`scenario_runs.executor_pid`, schema v18; insert + mapper only —
    never updated, like `replay_of_run_id`); `cancellation` UPDATE is
    write-once (`COALESCE(?, cancellation)`).
  - `packages/engine/src/scenario/run-types.ts`: `executorPid` field +
    reconcile-report `deferred` entry documentation;
    `packages/engine/src/engine.ts`: reconcile comment.
- Tests: `packages/engine/test/scenario-run.test.ts` (+4: cross-process
  cancel, write-once guard, live-owner defer, dead-owner terminalize →
  41); `packages/engine/test/store.test.ts` (schemaVersion 17 → 18 —
  the ONLY pre-existing assertion updated; nothing weakened).
- Docs: this report; `docs/reports/PHASE_08A_REPORT.md` (archive);
  PROGRESS entry; IMPLEMENTATION_PLAN T-3.6 = PARTIAL; TESTING §16;
  DECISIONS DEC-024/DEC-025; ARCHITECTURE CLI row.
- **API**: audit only — `apps/api` untouched. Existing typed routes
  already cover scenario CRUD/validate/operations and runs
  execute(202)/list (`scenarioId|networkId|state|replayOfRunId|limit|
  offset`)/get/cancel/replay(202 + `replayNote`); rejected-attempt
  persistence, run history, replay provenance, and the security posture
  are unchanged. Nothing was added because nothing was missing.

## 3. Acceptance criteria (PASS / FAIL / BLOCKED) with evidence

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| Scenario list/get/create/validate/operations via CLI over the shared engine | PASS | CLI unit 36/36; live test 1 (authoring) |
| Run execute/replay/list/get/cancel via CLI; engine is the ONLY executor | PASS | `program.ts` calls `engine.scenarioRuns.*` only; unit + live tests 2–5 |
| Explicit `-n, --network` on execute/replay; never inferred | PASS | commander-required option; unit (missing `--network`), live (ghost network) |
| Bounded `--timeout`; honest OPERATION_TIMEOUT ("keeps executing"), never success | PASS | unit timeout-honesty tests (execute + cancel) |
| Exit-code contract (completed*→0; rejected/failed/cancelled/cleanup-failed/timeout→1; validate 0/1; cancel 0 only on OBSERVED terminal) | PASS | unit tests per branch |
| Engine refusals surfaced with persisted `rejectedRunId` + actionable hint; no misattribution | PASS | unit + live gate-refusal test |
| Replay provenance + honesty note; re-confirmation of the network | PASS | live test 3 (`replayOfRunId`, distinct fault, note) |
| Cancellation works ACROSS PROCESSES (canceller ≠ executor); audit history preserved; source immutability | PASS | live test 4: execute in a REAL child process, cancelled by a separate `run cancel`; unit cross-process + write-once tests |
| Authorization/test-network gates intact (DEC-008); rejected attempts persisted | PASS | engine gates unchanged; live gate-refusal test |
| API audit complete; no duplicated routes; typed contracts untouched | PASS | §2 — zero API changes |
| No fabricated data anywhere in CLI output | PASS | every field printed comes from a real engine record |
| Regression: existing suites stay green after engine changes | PASS | unit 323/323; live scenario-runs 9/9, faults 5/5 |
| Full T-3.6 (incl. web UI) | BLOCKED (by scope, not by defect) | T-3.6B wiring pending — see §9 |

## 4. Exact commands and results (2026-10-21)

| Command | Result |
|---------|--------|
| `npm run typecheck` | PASS (exit 0, clean) |
| `npm run lint` | PASS (exit 0, clean) |
| `npm run build` | PASS (exit 0; benign rolldown notice) |
| `npm test` | **323/323 PASS (26 files)** — `scenario-commands` 36/36, `scenario-run` 41/41 |
| `npm run test:integration` (no gate) | 50 skipped / 12 files — `cli-scenario` 5 skipped (skipped ≠ passed) |
| `KAIZEN_TEST_LIVE=1 npx vitest run --config vitest.integration.config.mts test/integration/cli-scenario.int.test.ts` | **5/5 PASS** (~32 s, real network) |
| `KAIZEN_TEST_LIVE=1 … scenario-runs.int.test.ts` (regression re-run) | **9/9 PASS** |
| `KAIZEN_TEST_LIVE=1 … faults.int.test.ts` (regression re-run) | **5/5 PASS** |
| `pgrep -af portaldot` (hygiene, after live runs) | none |

## 5. Mocked vs live evidence (kept separate)

- **Mocked (offline)**: all 36 CLI unit tests use a scripted fake engine
  through the DI seam — they prove parsing, envelopes, exit codes, and
  honesty wording, NOT runtime behavior. Engine unit additions run real
  SQLite + the real injector against harness stand-in nodes.
- **Live (real `portaldot_dev`, disposable designatedTest networks)**:
  the 5 tests in `cli-scenario.int.test.ts` — the network is created by
  Kaizen itself; every execution claim is backed by an INDEPENDENT
  observation (own RPC polling + process identity), not just the CLI's
  printed record:
  1. authoring via CLI (validate never saves);
  2. a real pause run completes via `run execute`; the victim is
     reachable again with the SAME pid and a moving chain head;
  3. `run replay` replays a finished run as a NEW run with provenance
     (`replayOfRunId` + honesty note) and a DISTINCT fault record;
  4. **cross-process cancel**: the execute runs in a REAL child process
     (built bin, same `KAIZEN_DATA_DIR`); `run cancel` from the test
     process durably records the request; the child's engine interrupts
     the hold and the child honestly reports `{ok:false,
     state:"cancelled"}` with exit 1; the node returns with the SAME pid
     and RPC reachable; cancelling the finished run →
     SCENARIO_RUN_CONFLICT;
  5. gate refusals: ghost network refused with a persisted, inspectable
     rejected run; replay-of-rejected refused (no new run); missing
     `--network`; unknown ids → NOT_FOUND.
- Each engine cross-process fix followed: live failure observed → fix →
  live proof → unit regression test. Nothing was marked VERIFIED on
  mocked evidence alone.

## 6. What was NOT implemented (deliberate scope boundaries)

- **T-3.6B web-UI surface**: the imported UI was neither designed,
  regenerated, restyled, nor wired in this slice; existing UI files are
  untouched. Backend/CLI contracts and typed-client compatibility are
  preserved so the wiring task can start cleanly.
- No `--detach` mode (would lie about executor ownership; bounded waits
  instead — DEC-024).
- No API changes (audit found nothing missing); no new routes, no
  contract changes, no new dependencies.
- No wallet signing, no chain writes, no new T-8.x features; no
  Kubernetes/Helm work; no mainnet contact (DEC-008 gates intact).

## 7. Security considerations & risks

- The CLI never executes shell strings or host commands on behalf of the
  UI; all process execution stays engine-side (argv arrays, allowlists,
  timeouts — unchanged).
- Target selection is explicit and engine-gated: `--network` is a
  required flag resolved against designated-test networks; a refusal
  persists a rejected run (audit trail). Nothing in the CLI can aim a
  destructive operation at mainnet.
- Cancellation remains single-mechanism (`faults.cancel`, once) — the
  cross-process path never introduces a second executor or kills
  processes directly; signalling identity stays on the verified pid.
- `executor_pid` is stamped once and never updated (provenance
  semantics); reconcile only touches runs whose owner is verifiably
  dead — it can no longer disrupt a live operator session.
- No secrets, keys, or machine-specific paths in the diff; `.kaizen/`
  remains gitignored runtime state; the repo stays demo-able from a
  clean clone.

## 8. Cleanup / resource-release verification

- Live suites stop their networks in `afterAll`; the CLI child process
  is SIGKILLed in `afterAll` if it somehow outlives a failed test; runs
  always terminalize (cancel, deadline, or bounded timeout — a timeout
  reports honestly that the run keeps executing).
- `pgrep -af portaldot` after every live run: no leaked node processes.
- Temp debug instrumentation used during diagnosis was fully removed
  (grep-clean) before commit; engine/cli dist rebuilt from clean sources.

## 9. Remaining work & next task

- **Remaining for full T-3.6**: T-3.6B — wire the imported web UI to
  the existing Failure Lab API/typed client (no fabricated data, no
  restyling; UI wiring only). T-3.6 stays PARTIAL until that flow
  exists and its evidence is recorded.
- **Next task (recommended)**: **T-3.6B — Failure Lab UI integration**
  (imported UI → typed client → existing API routes), or the next
  roadmap task as directed.
