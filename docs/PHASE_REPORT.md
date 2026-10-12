# Phase 2B Report — Web UI & Live Operations Dashboard

**Date**: 2026-10-12
**Tasks**: T-2.5, T-2.6, T-2.7, T-2.10 (Phase 2B split from Phase 2;
Phase 2A was reported separately — archived at
`docs/reports/PHASE_02A_REPORT.md`)
**Outcome**: COMPLETE — every Phase 2B task is VERIFIED with recorded
evidence (this report, `docs/PROGRESS.md`, `docs/TESTING.md` §9). One
verification boundary is explicit: there is **no real-browser E2E** (RSK-23).

---

## 1. Summary & completed task IDs

Kaizen's lifecycle is CREATE → MONITOR → BREAK → DIAGNOSE → RECOVER →
DEPLOY. Phase 2B implements the **CREATE and MONITOR** screens of the first
functional web interface, on top of the already-verified Phase 2A engine +
API. The console is a thin typed client: no operation logic, no mock data,
no browser-side process execution (FR-1). Failure Lab, recovery, and
deployment work was deliberately **not started** (Phases 3–6).

Completed: **T-2.5** (scaffold + typed API/WS client + Overview/Networks),
**T-2.6** (network detail live dashboard + node detail), **T-2.7** (log tail
API + UI), **T-2.10** (tests + docs + this report). Two backend fixes rode
along because the UI needed them (documented, engine/API level):
`GET …/nodes/:id/logs` (new) and the node-detail on-demand sample fix
(DEC-017).

## 2. Screens and components implemented

Screens (React Router, all under the shared app shell):

| Route | Screen | Key contents |
|---|---|---|
| `/` | Overview | Fleet metrics **derived** from API responses (networks, running, unhealthy, total nodes), per-network health rollups ("not monitoring" when not running — never a guess), recent events, empty/loading/error/disconnected states |
| `/networks` | Networks | List (name, topology, status, node count, created), client-side filter, create form for all 5 presets incl. a custom node editor, server validation errors rendered per issue |
| `/networks/:id` | Network detail | Identity + persistence facts, nodes table (role/status/key/ports/expected peers), live monitoring table (health + reasons, peers n/expected, best/finalized, sync, uptime, sample age; `unreachable` cells; monitoring-off note when stopped), start/stop controls, purge/remove behind confirmation modals (disabled while running), per-network events |
| `/networks/:id/nodes/:nodeId` | Node detail | Identity/process (pid, started, ports, bootnodes, base dir), live chain data with explicit `RPC unreachable` state (error text shown, no invented numbers), connected-peers table, real log tail (auto-refresh while running), node start/stop |
| `/events` | Events | App-wide feed from the single WebSocket: kind filter, timestamps + network/node ids, expandable raw payloads, reconnect banner that states missed events are **not replayed**, clear-view |

Shared components: app shell (nav + live-connection indicator +
disconnection banner), status badges (network/node/degraded), health badges
with evidence tooltips, loading/empty/error states, accessible confirmation
dialog (Esc/backdrop cancel, focus management), async operation button
(disabled + progress + inline error, never optimistic), formatting helpers.
Styling: hand-rolled dark operations-console CSS (no UI framework) — tables,
badges, tiles, responsive down to mobile widths, focus-visible outlines.

Client layer: `KaizenApiClient` (single typed client; base URL config; 15s
default / 300s start / 120s stop timeouts; `ApiError` with code + status +
per-field issues; failed `OperationResult`s returned as values, not thrown)
and `KaizenEventStream` (one socket for the whole app via React context;
capped backoff + jitter reconnect; last-unsubscribe teardown; `resync`
callback → pages refetch REST instead of assuming missed events arrived).
Engine models are `import type`-only — zero runtime coupling, zero drift.

## 3. Files changed

- `apps/web/` — **new** src tree: `api/{types,client,events}.ts` (+ 2 test
  files), `state/{useAsync.ts,EventsContext.tsx}`, `components/{Layout,
  States,StatusBadge,ConfirmDialog,OperationButton}.tsx`, `components/fmt.ts`,
  `pages/{OverviewPage,NetworksPage,CreateNetworkForm,NetworkDetailPage,
  NodeDetailPage,EventsPage}.tsx` (+ 6 test files), `App.tsx`, `main.tsx`,
  `styles.css`, `test-utils/{fake.ts,fixtures.ts,render.tsx}`; updated
  `index.html`, `tsconfig.json`, `package.json` (react-router-dom; jsdom +
  testing-library dev-deps).
- `apps/api/src/server.ts` — new `GET /api/networks/:id/nodes/:nodeId/logs`
  (Zod-validated `maxBytes` 1 KiB–64 KiB); node-detail route now
  `getLatest() ?? snapshotNow()` (DEC-017).
- `packages/engine/src/network/service.ts` — new `nodeLogTail(nodeId,
  maxBytes)` (read-only; reuses the engine's existing `readLogTail`; clamped).
- `package.json` (root) — typecheck now includes `tsc -p apps/web --noEmit`.
- `vitest.config.mts` — web tests included in `npm test`.
- `test/integration/webclient.int.test.ts` — **new** live test (below).
- `test/integration/api.int.test.ts` — node-route contract updated for
  DEC-017 (null → honest unreachable/unhealthy sample).
- Docs: `IMPLEMENTATION_PLAN.md`, `PROGRESS.md`, `ARCHITECTURE.md`,
  `DECISIONS.md` (DEC-016/017), `RISKS.md` (RSK-23), `TESTING.md` (§9),
  `README.md`, this report (2A archived to `docs/reports/PHASE_02A_REPORT.md`).

## 4. API endpoints and WebSocket events integrated

REST (all existing; one added): `GET /api/health`, `GET /api/binaries`,
`GET/POST /api/networks`, `GET/DELETE /api/networks/:id`,
`POST /api/networks/:id/{start,stop,purge}`, `GET /api/networks/:id/monitor`,
`GET/POST …/nodes/:nodeId/{start,stop}`, **NEW**
`GET …/nodes/:nodeId/logs` (real log-tail bytes from the engine).

WebSocket `/api/events` (single connection app-wide): `hello`,
`network.created`, `network.status`, `node.status`, `monitor.sample`,
`monitor.health`, `monitor.peers`, `monitor.error`, `operation.completed` —
rendered in the event feed with real timestamps and identifiers; WS
reconnects increment a resync generation that triggers REST refetches on
every page.

## 5. Exact test commands and actual results

| Command | Result |
|---|---|
| `npm run typecheck` | **OK** (engine, cli, api, web — web added this phase) |
| `npm run lint` | **OK** — 0 problems |
| `npm run build` | **OK** — engine→cli→api→web; web bundle 304.15 kB (93.28 kB gzip). Rolldown prints a benign `use client` directive warning from react-router (their code, browser bundle, no effect) |
| `npm test` | **113 passed / 17 files** — 81 pre-existing engine/CLI (unchanged) + 32 new web tests (client 7, events stream 6, Overview 4, Networks 4, NetworkDetail 4, NodeDetail 3, EventsPage 4) |
| `KAIZEN_TEST_LIVE=1 npm run test:integration` | **30 passed / 8 files, 224.79s** (Phase 2A's 25 + webclient 5). One failure mid-phase was api.int asserting the pre-DEC-017 contract; test updated, api.int re-run **6/6**, webclient standalone **5/5** |
| `pgrep -ax portaldot_dev` (after suites) | **no orphans** |
| CLI smoke | **not re-run** — CLI untouched this phase; the engine change is additive-only (`nodeLogTail`) and all engine tests are green. (Phase 2A's 21/21 smoke stands for the CLI surface.) |

Secrets scan: `git diff` inspected before commit — no keys, no `.kaizen/`
state, no credentials, no machine-specific absolute paths in committed code.

## 6. Real backend/infrastructure verification vs mocks

**Real (infrastructure)** — `test/integration/webclient.int.test.ts` runs
the ACTUAL `KaizenApiClient` + `KaizenEventStream` (the browser's code, Node
24 provides fetch/WebSocket) against a real API server + engine/StateStore +
a real `portaldot_dev` single-node network:

- health + structured validation errors through the client;
- create → detail → `network.created` observed on the UI stream with real
  timestamp; structured 404s;
- health-gated start; monitor shows `healthy`, peers `0/0`, real head
  number, `0x…` genesis; node detail carries the same evidence; values
  **cross-checked against an independent raw RPC read** of the same node
  (head within drift, peer count equal, real `12D3KooW…` peer id);
- new logs endpoint returns real log bytes from disk (`listening for new
  connections…`); invalid `maxBytes` → structured 400;
- stop → `stopped` + honest `unhealthy`/unreachable; typed
  `network.status running/stopped` events on the stream; cleanup via client.

**Mocks/fixtures** — all 32 web unit/component tests (jsdom, scripted
`FakeWebSocket`, recorded-shape fixtures). They verify rendering and state
logic only.

**Not done (honest boundary)** — no real-browser E2E: rendering in an
actual browser was not exercised (no Playwright in the repo; adding browsers
was judged out of scope for this phase). RSK-23 tracks this; Phase 7 is the
planned place for a clean-clone browser smoke. This report therefore claims
"client-layer verified live against real nodes", **not** "browser-verified".

## 7. Acceptance criteria — PASS/FAIL/BLOCKED

### 7.1 Phase-plan tasks (`docs/IMPLEMENTATION_PLAN.md`, Phase 2B table)

| Task | Verdict | Evidence |
|---|---|---|
| T-2.5 scaffold, typed API/WS client, list/create, no mock data | **PASS** | unit: client/events/list/create suites; live: webclient create + stream. `grep` shows no fixture/mock import outside `*.test.*`/`test-utils` |
| T-2.6 live dashboard (peers/head/finalized/health; explicit unknowns) | **PASS** (AC re-scoped & noted in plan: live values update via bounded 5s REST polling + WS-driven invalidation — real-time, not per-value WS pushes) | live webclient monitor + cross-check; unit: unreachable/unhealthy renderings |
| T-2.7 log tail API/UI | **PASS** (scope: tail + bounded-refresh follow; no since-timestamp streaming — recorded) | live webclient logs test (real bytes); unit: log pane |
| T-2.10 tests + docs + report | **PASS** | this report; PROGRESS/TESTING/PLAN consistent |

### 7.2 User-phase requirements (this assignment)

| Requirement | Verdict | Evidence |
|---|---|---|
| Establish existing frontend on the repo's stack; keep usable on desktop+mobile | **PASS** | Vite+React retained; responsive CSS (breakpoints 720/860/980px, scroll-wrapped tables) |
| Fix backend where genuinely missing, in engine/API, documented | **PASS** | logs endpoint + DEC-017 fix, both in engine/API with docs |
| Overview with all metrics from real API responses + states | **PASS** | derived metrics; empty/loading/error/disconnected covered by tests |
| Networks list/create/filter/validation errors/refresh | **PASS** | NetworksPage tests (4) incl. create + structured issues |
| Network detail: nodes, connectivity, sync, blocks, health; explicit unavailable/stale; supported controls only | **PASS** | monitor table with `unreachable` cells; start/stop/purge/remove wired to real endpoints only |
| Node detail: identity, health, peers, sync, blocks, logs/events, clear errors | **PASS** | NodeDetail tests + live log bytes + `RPC unreachable` state |
| Events from the real WS with timestamps/ids, reconnect, no duplicate subscriptions/rendering | **PASS** | single-socket guarantee (unit), one-row-per-delivery (unit), reconnect banner (unit), real events live (webclient) |
| Shared typed client; centralized base URL/errors; timeouts; cleanup; no excessive polling | **PASS** | DEC-016; polling cadences listed in PROGRESS §1, all paused when idle |
| Browser never launches processes/shell; no fake metrics/mock data in prod UI | **PASS** | all ops via POST endpoints; test fixtures confined to test files |
| Interface quality (hierarchy, states, confirmations, a11y, no decoration) | **PASS** | console-dark CSS, confirm modals with Esc/focus, focus-visible, aria labels |
| Tests: client, flows, states, WS rendering, reconnect, controls, unavailable data | **PASS** | 32 unit + 5 live (§5) |
| Run real build/typecheck/lint/tests; separate frontend tests from backend verification; no false E2E claims | **PASS** | §5/§6 and explicit boundary |
| Update docs; preserve task IDs; record screens/integrations/evidence/outstanding work | **PASS** | §8 |
| No Failure Lab / K8s / Phase 3 work started | **PASS** | untouched; recorded as remaining |
| Full report in PHASE_REPORT.md; 2A archived; git diff inspected | **PASS** | this file; `docs/reports/PHASE_02A_REPORT.md` |

## 8. Known issues, risks, remaining work

- **RSK-23 (new, OPEN)**: no real-browser E2E — rendering verified by jsdom
  tests only; client transport verified live. Planned: Playwright smoke in
  Phase 7.
- WS reconnect does not replay missed events (by design, DEC-016); pages
  refetch REST state and the Events page states this openly. A user can
  still miss a fast transient event between reconnects.
- Log "follow" is bounded refresh (10s while running), not streaming; no
  since-timestamp tailing yet.
- Event feed is capped at 500 in-memory events per session (no pagination).
- CLI smoke not re-run this phase (see §5).
- Not started, per instruction: Failure Lab & scenarios (Phase 3), incident
  timelines (Phase 4), validator transactions (Phase 5), Docker/K8s
  deployment (Phase 6), security audit (Phase 7).

## 9. Documentation updated

`docs/IMPLEMENTATION_PLAN.md` (Phase 2B statuses + T-2.10),
`docs/PROGRESS.md` (full entry: files, gates, boundary, bugs, decisions),
`docs/ARCHITECTURE.md` (web component + logs route), `docs/DECISIONS.md`
(DEC-016, DEC-017), `docs/RISKS.md` (RSK-23), `docs/TESTING.md` (§9 with
reproduction commands), `README.md` (status + Web UI quickstart + reports
table row), `docs/PHASE_REPORT.md` (this file; 2A archived to
`docs/reports/PHASE_02A_REPORT.md`).

## 10. Exact recommended next action

Start **Phase 3 — Failure Lab & Scenarios** at **T-3.1** (failure-mechanism
feasibility spike: process signals vs single-host network isolation; keep
the DEC-008 designated-test-network gate intact; record mechanism
capabilities in `docs/TECHNICAL_RESEARCH.md` before building the injector).
