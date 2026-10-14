# Phase 3C Report — Scenario Model & Authoring Foundation (T-3.3)

**Date**: 2026-10-14
**Tasks**: T-3.3 only. Scenario execution/recording (T-3.4), replay
(T-3.5), CLI/UI surfaces for the Failure Lab (T-3.6), diagnostics
(Phase 4), and recovery orchestration were explicitly NOT started — this
report stops at the authoring foundation, per instruction. The previous
report (Phase 3B, T-3.2 FailureInjector) is archived verbatim at
`docs/reports/PHASE_03B_REPORT.md`; Phase 3A remains at
`docs/reports/PHASE_03A_REPORT.md`.

## 1. Scope & Exclusions

**In scope (delivered):**

- Typed, versioned scenario model: stable ids, name/description/tags,
  explicit target-network requirements, ordered steps (stable step ids,
  explicit order), typed operation + strict schema-validated config,
  bounded delays, typed pre/postconditions, bounded per-step timeouts,
  explicit failure/cancellation semantics as persisted enums.
- Safe operation registry derived from the FailureInjector's ACTUAL
  adapters (`describeMechanisms()`), distinguishing supported
  (`pause`, `terminate`), blocked (`peer-disconnect`, `partition` — with
  the adapters' unblock paths verbatim), and planned (`node-restart`)
  operations. Descriptive only; never a bypass of runtime safety.
- Deterministic, UI-independent validation returning structured issues
  (stable code, severity, scenario/step id, field path, explanation,
  remediation).
- SQLite persistence (migrations 9–10, schemaVersion 8→10) with atomic
  create/update, uniqueness, restart reload, and honest malformed/
  schema-mismatch handling.
- Minimal authoring REST surface (list/get/create/update/delete +
  validate-without-save + registry) and typed client contracts for the
  future CLI/UI.

**Explicitly out of scope (sequencing boundary, not scope reduction):**

- No scenario executor, run history, or replay (T-3.4/T-3.5).
- No Failure Lab UI, no new CLI commands (T-3.6 owns those surfaces).
- No incident timelines, diagnostics, or recovery orchestration
  (Phase 4 / T-4.4). All roadmap tasks remain planned and unchanged.

## 2. Files

**New**

| File | Purpose |
|------|---------|
| `packages/engine/src/scenario/types.ts` | Model: limits, operations, conditions (+ evaluability), execution policy enums, target requirements, steps, validation result types, persisted record |
| `packages/engine/src/scenario/operations.ts` | Safe operation registry built from `describeMechanisms()`; condition definitions; strict config schemas; JSON-safe serialization |
| `packages/engine/src/scenario/validate.ts` | Zod schemas + normalization + all semantic rules; `validateScenarioInput` / `prepareScenario` (pure, deterministic) |
| `packages/engine/src/scenario/service.ts` | `ScenarioService`: list/get/create/update/remove/validate/describeOperations + audit events |
| `packages/engine/test/scenario.test.ts` | 32 unit tests (model, registry, validation) |
| `packages/engine/test/scenario-store.test.ts` | 11 persistence tests (real SQLite, file-backed restart) |
| `apps/api/test/scenarios.test.ts` | 18 API tests (real Fastify app + real SQLite via `app.inject`) |
| `docs/reports/PHASE_03B_REPORT.md` | Phase 3B report archived verbatim |

**Modified**

| File | Change |
|------|--------|
| `fault/adapter.ts` | ADDITIVE: `AdapterSupport` type, `FaultMechanismInfo`, `support` field on `FaultAdapter` |
| `fault/adapters/{pause,terminate}.ts` | `support: { status: 'supported' }` |
| `fault/adapters/blocked.ts` | `PEER_DISCONNECT_SUPPORT` / `PARTITION_SUPPORT` consts now single-source (static `support` + preflight read the same reason/unblock text) |
| `fault/injector.ts` | ADDITIVE: `describeMechanisms()` (read-only view of registered adapters) |
| `state/store.ts` | Migrations 9–10 (`scenarios` table, recency index); scenario CRUD + `mapScenarioRow` with structured read errors |
| `errors.ts` | `SCENARIO_NOT_FOUND`, `SCENARIO_ALREADY_EXISTS`, `SCENARIO_INVALID`, `SCENARIO_MALFORMED`, `SCENARIO_VERSION_UNSUPPORTED` |
| `events/bus.ts` | `scenario.created|updated|deleted` audit events |
| `engine.ts` / `index.ts` | `engine.scenarios` wiring (registry from the live injector); scenario exports |
| `apps/api/src/server.ts` | Scenario routes; status mappings; malformed-JSON now honors Fastify's 4xx (structured 400, was 500) |
| `apps/web/src/api/{client,types}.ts` + `client.test.ts` | Typed scenario client contract (+4 tests) |
| `packages/engine/package.json` + `package-lock.json` | `zod ^4.6.5` (project-standard boundary validation; same version as `apps/api`, workspace-hoisted) |
| `packages/engine/test/{store,fault}.test.ts` | schemaVersion 10 assertion; `describeMechanisms` mirror test (+1) |
| `vitest.config.mts` | Include `apps/api/test/**` |

## 3. Model & Registry Design

- **Operations**: `ScenarioOperationType = FaultType | 'node-restart'`.
  Fault types come straight from the injector; extending `FAULT_TYPES`
  extends the model surface. Configs are strict Zod objects (`node` label
  + optional bounded `durationMs` for pause) — unknown fields (including
  secret-named keys) are rejected by construction; there is no
  shell/command/signal/env/path field anywhere.
- **Registry provenance**: built in `engine.ts` from
  `faults.describeMechanisms()`, whose `support` declarations ARE what
  blocked-adapter preflight reports (one source of truth). A registry
  entry saying `supported` means "the mechanism exists in the engine
  today" — not "run this anywhere": the executor (T-3.4) must still go
  through the injector's preflight/gates (DEC-008/DEC-018/DEC-019).
- **Conditions** are discriminated-union typed data (never strings) with
  per-kind evaluability from the condition registry. Supported kinds map
  exactly onto what monitoring/health/fault-claims can evaluate today
  (`rpc-reachable`, `process-state`, `health-state`, `peers`, `syncing`,
  `chain-progress` via stall detection, `recovery-verified`).
  `finality-progress` and `runtime-event` exist in the model with
  evaluability `planned` and are REJECTED with
  `CONDITION_NOT_EVALUABLE` (+ remediation) — the model never pretends a
  condition can be checked.
- **Ordering/timing**: array position is authoritative; explicit `order`
  that contradicts position is an error, not silently normalized. Missing
  step ids are assigned deterministically (`step-N`). Delays are bounded
  (0..300 s), step timeouts 5 s..15 min, pause holds 0..600 s with the
  step timeout required to cover hold + 60 s cleanup/recovery headroom,
  and the worst-case scenario (Σ delays + timeouts) capped at 30 min.
- **Failure semantics**: persisted enums for precondition-fail
  (`skip-step|abort-run|cancel-run`), step-fail
  (`abort-run|continue|cancel-run`), inconclusive verification
  (`fail-step|warn-and-continue`), step timeout (`fail-step|cancel-run`),
  plus the fixed safe pair `onCleanupFailed: cancel-run` /
  `cancellation: cleanup-then-stop` (cleanup-failed already quarantines
  the target in the injector; the only safe scenario reaction today is to
  stop the run). No partial-execution loop exists in the service.
- **Severity discipline**: blocked/planned operations are authorable only
  as WARNINGS (scenario saves with `validationStatus: 'warning'`) so
  drafts can exist, but nothing about them may read as executable;
  unknown operations, invalid configs, contradictions, un-evaluable
  conditions, safety violations, and bounds violations are errors
  (not savable).

## 4. Persistence & API

- SQLite `scenarios` table (migration 9; index 10): UNIQUE name, JSON
  columns (tags/requires/steps/execution/validation), validation result +
  `valid|warning` status persisted alongside the definition. Inserts and
  full-record replaces are single-statement atomic; UNIQUE violations →
  `SCENARIO_ALREADY_EXISTS`; zero-row update → `SCENARIO_NOT_FOUND`.
  Update re-validates the merged scenario as a whole (provenance
  `createdBy/createdAt` preserved, `updatedBy/updatedAt` refreshed).
- Rows this build cannot parse or whose `schema_version` is newer are
  surfaced as structured per-row `malformed` entries in list results
  (`SCENARIO_MALFORMED` / `SCENARIO_VERSION_UNSUPPORTED` on direct get) —
  never dropped, never half-parsed.
- REST: `GET /api/scenarios` (q/tag/status filters, limit/offset paging,
  totals), `GET /api/scenarios/operations` (serialized registry),
  `POST /api/scenarios/validate` (200 + validity — a query), `POST
  /api/scenarios` (201), `GET/PUT/DELETE /api/scenarios/:id`. Errors:
  400 `SCENARIO_INVALID` (structured `details.issues`), 404
  `SCENARIO_NOT_FOUND`, 409 `SCENARIO_ALREADY_EXISTS` /
  `SCENARIO_VERSION_UNSUPPORTED`, 400 for malformed JSON (now honoring
  Fastify's 4xx classification with a structured envelope). Authorization
  is the unchanged DEC-019 posture: loopback-only, JSON-only; scenario
  authoring adds no host-execution power, so no new auth model was needed
  and none was invented.

## 5. Test Results (counts by layer)

| Layer | File | Tests | Nature |
|-------|------|-------|--------|
| Unit (pure model/registry/validation) | `packages/engine/test/scenario.test.ts` | 32 | real injector registry + injected synthetic registries; no processes/clock |
| Unit (persistence) | `packages/engine/test/scenario-store.test.ts` | 11 | real SQLite (`:memory:` + file-backed restart), raw-SQL corruption injection |
| API (app + db integration) | `apps/api/test/scenarios.test.ts` | 18 | real Fastify app + real SQLite via `app.inject`; no portaldot |
| Unit (regression, added) | `packages/engine/test/fault.test.ts` +1, `apps/web/src/api/client.test.ts` +4, `store.test.ts` schemaVersion | 5 | mirror test, typed client contract, migration assertion |
| **Total `npm test`** | 21 files | **202/202 passed** | 136 prior + 66 new |
| Live integration (regression) | `test/integration/*` | **35/35 passed** (9 files, 346 s) | real `portaldot_dev`; full T-3.2 injector + network + API + webclient suites intact |

Gates (2026-10-14): `npm run typecheck` pass; `npm run lint` pass;
`npm run build` pass; `npm test` 202/202;
`TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin
KAIZEN_TEST_LIVE=1 npm run test:integration` 35/35.
No live-node work was required by T-3.3 itself (authoring is pure data);
the live run is regression evidence.

## 6. Acceptance Criteria

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Typed model matches architecture (ordered actions, delays, conditions, explicit failure semantics, versioned) | PASS |
| 2 | Registry reflects the actual injector (supported/blocked/planned; unblock paths verbatim; blocked never executable) | PASS (registry built from `describeMechanisms()`; mirror test) |
| 3 | Pre/postconditions, ordering, delays, timeouts, failure policies represented AND validated | PASS |
| 4 | Deterministic structured validation (byte-identical results; stable codes/paths/remediation) | PASS (asserted) |
| 5 | Scenarios persist across restart | PASS (file-backed reload byte-identical) |
| 6 | CRUD + validation tested (valid/invalid, unknown ids, malformed JSON, error formatting, filtering, auth posture) | PASS (18 API + 11 store tests) |
| 7 | CRUD/validate cannot trigger fault execution | PASS (zero fault events/records/active faults after full CRUD+validate; no execute/run/replay routes exist — 404 by absence) |
| 8 | Injector safety + regression tests pass | PASS (fault suite green; live 35/35) |
| 9 | Docs/report match the code | PASS (ARCHITECTURE §6, DEC-020, RSK-28, TESTING §12, PROGRESS, this report) |
| 10 | Prior reports preserved | PASS (3A intact; 3B archived verbatim as `docs/reports/PHASE_03B_REPORT.md`) |
| 11 | Roadmap intact (T-3.4–T-3.6, Phases 4–6 unchanged) | PASS |

**Overall: PASS.**

## 7. Limitations & Risks

- Validation is **authoring-time only**; its guarantees (preconditions,
  bounds, blocked ops) are inert until T-3.4's executor revalidates every
  run through the injector's own gates. Tracked as **RSK-28** and as an
  explicit acceptance gate for T-3.4.
- Node references are topology *labels* (e.g. `alice` → `<net>-alice`);
  label resolution against a concrete network is an executor concern
  (T-3.4). With `requires.preset: 'custom'` labels cannot be verified at
  authoring time — a deliberate `TARGET_NODE_UNVERIFIABLE` warning.
- `chain-progress` evaluation rides on the health machine's stall
  detection; `finality-progress` and `runtime-event` conditions remain
  `planned` (rejected) until monitoring/incident work makes them
  evaluable.
- The registry is a snapshot of injector capabilities at engine
  construction; run-time enforcement is the injector's, not the
  registry's, job by design (DEC-020).
- No CLI command for scenarios yet (T-3.6) and no UI — the typed web
  client methods are the contract both will consume.

## 8. Documentation

Updated: `ARCHITECTURE.md` (§6 scenario authoring), `DECISIONS.md`
(DEC-020), `RISKS.md` (RSK-28), `TESTING.md` (§12), `PROGRESS.md`
(Phase 3C entry), `IMPLEMENTATION_PLAN.md` (T-3.3 → VERIFIED),
`README.md` (status line + capability bullet). `TECHNICAL_RESEARCH.md`
unchanged — no new research findings (the injector's `support`/`describeMechanisms`
extension is documented in ARCHITECTURE/DEC-020).

## 9. Hygiene

- Scoped diff, reviewed; secret scan of the full diff clean (only
  intentional fake-secret test literals such as `hunter2` in negative
  tests; no keys, credentials, or machine paths committed).
- `.kaizen/` untouched; no binaries or generated data in the commit.
- Post-live-run process hygiene: no orphaned `portaldot_dev` processes,
  no leftover netns/iptables rules (the live suites assert this and
  passed).
- Engine now depends on `zod` (workspace-hoisted, same version as the
  API) — justified by the repo-wide Zod-at-boundaries rule; lockfile
  updated.

## 10. Confirmation: authoring cannot execute faults

By construction and by test: `ScenarioService` has no reference to the
injector's execution methods (it receives only `describeMechanisms()`);
CRUD/validate touch only the `scenarios` table; the API exposes no
execute/run/replay route (404 by absence, test-asserted); the full
CRUD+validate flow leaves zero fault events, zero fault records, and zero
active faults; and reading a saved scenario emits nothing (it is inert
data). The blocked-adapter statuses in the registry mean even the future
executor cannot treat `peer-disconnect`/`partition` as executable without
the recorded unblock work landing in the engine first.

## 11. Next Task

**T-3.4** — ScenarioEngine execution with per-action recording
(timestamps, results, errors) and cancellation, consuming this model
unchanged and executing ONLY through the FailureInjector's existing
dry-run→execute gate discipline against designated test networks. T-3.5
(replay) and T-3.6 (CLI/UI) follow per the roadmap; the Failure Lab is
NOT finished — this phase delivered its authoring foundation only.
