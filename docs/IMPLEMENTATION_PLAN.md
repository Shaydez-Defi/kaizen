# Implementation Plan

Status: ACTIVE (created Phase 0, 2026-10-09).

Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `IMPLEMENTED` · `VERIFIED`.
`IMPLEMENTED` ≠ `VERIFIED`: a task is VERIFIED only after its acceptance
criteria were tested and evidence recorded in `docs/PROGRESS.md`.

Priority mapping: P0 = essential working core, P1 = core completeness,
P2 = planned wow-factor (Kubernetes/Helm — investigated early, never abandoned).

Dependency notation: "→" means "depends on".

---

## Phase 1 — Foundation & Node Lifecycle Core (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-1.1 | Scaffold npm-workspaces monorepo (TS strict, eslint, vitest, root scripts) | — | P0 | `npm install` + `npm run build` + `npm test` pass on empty-ish packages; layout matches ARCHITECTURE §11 | run commands; CI-ready output | NOT STARTED |
| T-1.2 | Engine core types + StateStore (SQLite: networks, nodes, runs, history) | T-1.1 | P0 | typed models for NetworkDefinition/NodeConfig/OperationResult; migrations run; store unit-tested | vitest unit tests | NOT STARTED |
| T-1.3 | BinaryManager: download `portaldot_dev`+`subkey`, cache in `.kaizen/bin`, SHA-256 TOFU record | T-1.2 | P0 | fresh env can fetch binary; hash recorded; `--version` runs from cache; idempotent re-run | integration test w/ real download (env-gated) | NOT STARTED |
| T-1.4 | NodeProcessManager: argv-array spawn, per-node base-path, port allocation, log capture, SIGTERM→SIGKILL stop, restart, DB-wedge detection | T-1.3 | P0 | start dev node → reaches block production; stop within timeout; no orphan procs; SIGKILL+restart recovers DB; wedge detected | integration test vs real node | NOT STARTED |
| T-1.5 | PortaldotRpcClient (@polkadot/api over WS): health/peers/sync/header/events; reconnect w/ backoff | T-1.3 | P0 | WS client connects to live node; returns typed snapshots; survives node restart (reconnects) | integration test vs real node | NOT STARTED |
| T-1.6 | NetworkService: single + two-node presets via build-spec chain-spec generation; create/start/stop/inspect services | T-1.4, T-1.5 | P0 | one call creates a real 2-node network that peers and finalizes; inspect returns real peerIds/heights | integration test replicating Phase 0 experiment through the engine | NOT STARTED |
| T-1.7 | CLI skeleton (`kaizen network create/start/stop/status`, `--json`) | T-1.6 | P0 | CLI drives the same services; `--json` output parseable; exit codes correct | shell-driven smoke test w/ real network | NOT STARTED |
| T-1.8 | API skeleton (Fastify REST + Zod validation + WS event bus) | T-1.6 | P0 | REST endpoints mirror engine ops; invalid input → 400 with structured error; WS streams engine events | supertest + live smoke | NOT STARTED |
| T-1.9 | Phase-1 test suite + docs update (PROGRESS/TESTING/RESEARCH status flips) | T-1.7, T-1.8 | P0 | suite green; evidence recorded | `npm test`; docs diff review | NOT STARTED |

## Phase 2 — Multi-Node Networks, Monitoring & Web UI (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-2.1 | Inspect Local Testnet genesis authorities; finalize topology preset model (incl. validator+fullnode, custom) | T-1.6 | P0 | authority set documented in RESEARCH (R-05 flip); presets defined as data | script reads spec; doc update | NOT STARTED |
| T-2.2 | ChainSpec service: per-network spec generation, bootnode wiring, purge/reset support | T-2.1 | P0 | network of N nodes each with correct `--bootnodes`; reset supported | integration test (4-node) | NOT STARTED |
| T-2.3 | Four-validator + validator+fullnode presets; ordered start/stop; expected-peer verification | T-2.2 | P0 | 4 nodes peer fully; fullnode follows chain; stop/start cycle clean | integration test | NOT STARTED |
| T-2.4 | MonitoringService: periodic RPC sampling → event bus; stall/health state machine (RUNNING/DEGRADED/UNREACHABLE/STALLED) | T-1.5 | P0 | samples emitted ≥1/2s; killing a node flips state correctly | integration test | NOT STARTED |
| T-2.5 | Web app scaffold (Vite+React): layout, API/WS client, network list/create view | T-1.8 | P0 | UI creates and lists real networks; no mock data anywhere | manual + component tests | NOT STARTED |
| T-2.6 | Live network dashboard (nodes table: height/finalized/peers/health/roles, logs pane) | T-2.4, T-2.5 | P0 | dashboard shows live values updating over WS from a real network | e2e smoke (real nodes) | NOT STARTED |
| T-2.7 | Log capture & tail API/UI (per node, since timestamp, follow mode) | T-2.2, T-2.5 | P1 | tail + follow works for any managed node | e2e smoke | NOT STARTED |

## Phase 3 — Failure Lab & Scenarios (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-3.1 | Fault mechanism study: peer disconnect (reserved-peer RPC vs rewire), pause (SIGSTOP/SIGCONT), partition (isolation strategy) on single host | T-2.3 | P0 | each mechanism proven with evidence; documented in RESEARCH | recorded experiments | NOT STARTED |
| T-3.2 | FailureInjector with safeguards (designated-test-network gate, dry-run preview, timeouts, cleanup) | T-3.1 | P0 | destructive op refused on non-test target; every fault logged w/ actor/target/result | unit + integration tests | NOT STARTED |
| T-3.3 | Scenario model + authoring (ordered actions, delays, conditions; CRUD + validation) | T-3.2 | P0 | invalid scenarios rejected with precise errors; valid saved to SQLite | unit tests | NOT STARTED |
| T-3.4 | ScenarioEngine execution w/ per-action recording (timestamps, results, errors) + cancellation | T-3.3 | P0 | scenario runs against live network; history complete incl. failures | integration test | NOT STARTED |
| T-3.5 | Replay (deterministic action replay with documented semantics) | T-3.4 | P0 | replay re-executes same action sequence; UI/CLI states replay≠identical-outcome | integration test | NOT STARTED |
| T-3.6 | CLI + API + UI surfaces for Failure Lab & scenarios | T-3.4, T-2.5 | P0 | full flow usable from both CLI and UI | e2e smoke | NOT STARTED |

## Phase 4 — Incident Detection & Diagnostics (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-4.1 | Signal collectors: process exit, RPC unreachable, peer drop, block stall, `imOnline.SomeOffline` (WS events) | T-2.4 | P0 | each signal fires on induced fault; recorded | integration test w/ fault injection | NOT STARTED |
| T-4.2 | Incident model + correlation + timeline (affected nodes, network deltas) | T-4.1 | P0 | induced fault produces one incident w/ ordered timeline | integration test | NOT STARTED |
| T-4.3 | Evidence collection (log excerpts, RPC snapshots, artifact paths) + retention | T-4.2 | P0 | incident carries retrievable evidence bundle | integration test | NOT STARTED |
| T-4.4 | Recovery operations (restart, reconnect, purge/reinit) + outcome recording | T-3.2, T-4.2 | P0 | recovery from induced fault recorded w/ outcome; network returns healthy | integration test | NOT STARTED |
| T-4.5 | Incident UI/CLI views (timeline, evidence, symptom labeling — never unproven root-cause claims) | T-4.3, T-4.4, T-2.5 | P0 | UI shows incident + evidence from real run | e2e smoke | NOT STARTED |

## Phase 5 — Validator Operations (P1)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-5.1 | Read-only validator/session/staking views (era, session, validators, prefs) from real storage | T-2.3 | P1 | values come from chain storage; unknowns shown as unknown, never invented | integration test | NOT STARTED |
| T-5.2 | Session-key inspection (keystore presence, `Session.Keys` decode from metadata) | T-5.1 | P1 | decoded against live metadata V13 | integration test | NOT STARTED |
| T-5.3 | Guarded staking ops (bond/validate/chill on throwaway local net) with effect explanation | T-5.1 | P1 | extrinsic submitted via @polkadot/api succeeds; events recorded; documented effects | integration test | NOT STARTED |
| T-5.4 | `setKeys` flow (generate → insert keystore → setKeys → verify) where prerequisites met | T-5.2 | P1 | full loop verified or documented BLOCKED with evidence | integration test | NOT STARTED |

## Phase 6 — Deployment: Docker + Kubernetes/Helm (P1/P2 wow-factor)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-6.1 | Node Docker image (multi-stage, non-root, healthcheck) + build smoke test | T-1.3 | P1 | image builds; container runs `--dev`; RPC answers | docker run + RPC probe | NOT STARTED |
| T-6.2 | DockerAdapter (deploy/status/logs/destroy multi-node on one host) | T-2.2, T-6.1 | P1 | engine deploys 2-node net in Docker; peers verified | integration test | NOT STARTED |
| T-6.3 | Helm chart for multi-node Portaldot (StatefulSets, PVCs, headless service, readiness from RPC) | T-6.1 | P2 | `helm lint` clean; installs on minikube; pods become ready | helm install on minikube | NOT STARTED |
| T-6.4 | K8sHelmAdapter + deployment health monitoring + recovery path | T-6.3, T-2.4 | P2 | deploy/status/logs/destroy/recover via engine; UI shows cluster health | integration test on minikube | NOT STARTED |
| T-6.5 | Deployment surfaces in CLI/UI (deploy target selection, feedback) | T-6.2, T-6.4, T-2.5 | P2 | full deploy flow from UI and CLI | e2e smoke | NOT STARTED |

## Phase 7 — Hardening, Testing & Reproducible Setup (P1)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-7.1 | End-to-end suite: CREATE→MONITOR→BREAK→DIAGNOSE→RECOVER→DEPLOY scripted demo | all P0 | P1 | one command runs the full lifecycle on a clean machine | recorded run | NOT STARTED |
| T-7.2 | Reproducible setup (README quickstart verified from scratch, pinned versions, checksums) | T-7.1 | P1 | fresh-clone quickstart works following only README | clean-env rehearsal | NOT STARTED |
| T-7.3 | Security pass: argv validation, RPC exposure audit, secret handling review, `.gitignore` hygiene | T-6.5 | P1 | checklist in TESTING.md all green | manual audit + tests | NOT STARTED |
| T-7.4 | Error-handling & UX polish pass (structured errors everywhere, timeouts, cancellation) | all | P1 | no unhandled rejections; every failure path yields actionable message | fault-injection tests | NOT STARTED |
| T-7.5 | Demo materials (scripted walkthrough, seeded scenarios, screenshots) | T-7.1 | P2 | demo reproducible in <15 min | rehearsal | NOT STARTED |

---

## Milestone Gates

- **G1 (end Phase 1)**: engine can manage a real single node end-to-end; API+CLI exist.
- **G2 (end Phase 2)**: 4-node network created from UI with live monitoring.
- **G3 (end Phase 4)**: full BREAK→DIAGNOSE→RECOVER loop demonstrated with history.
- **G4 (end Phase 6)**: Helm deploys the same network class to minikube (wow-factor).
- **G5 (end Phase 7)**: reproducible demo from clean clone.

## Explicit Risk-First Sequencing Note

T-6.3/T-6.4 (K8s/Helm) carry the highest uncertainty (R-08/R-18, RSK-04/RSK-11).
Although P2, a **feasibility spike** (minikube start + bare chart install of a
single Portaldot pod) should be scheduled no later than mid-Phase 2 so blockers
surface early; full implementation stays in Phase 6.
