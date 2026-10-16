# Engineering Progress Log

Chronological, append-only. Every entry: date, phase/task IDs, files touched,
work done, commands executed, actual results, problems, decisions, remaining
work, exact next step.

---

## 2026-10-09 — PHASE 0: Foundation, Technical Discovery & Build Governance

**Phase/Task IDs**: Phase 0 (discovery); feeds tasks T-1.x planning.
**Files created/modified**: `README.md` (replaced 1-line stub),
`AGENTS.md`, `docs/PROJECT_SPEC.md`, `docs/TECHNICAL_RESEARCH.md`,
`docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROGRESS.md`
(this file), `docs/DECISIONS.md`, `docs/TESTING.md`, `docs/RISKS.md`.
No application code written (per Phase 0 constraints).

### 1. Workspace & environment inspection (actual results)

- Git: branch `main`, up to date with `origin/main`
  (`https://github.com/Shaydez-Defi/kaizen`), **clean working tree**, single
  commit `1bcbc0c Initial commit`. Existing files: `README.md` (content:
  `# kaizen`), `LICENSE` (MIT, © 2026 shaydez). Nothing overwritten beyond the
  trivial README stub; no uncommitted user work existed.
- Toolchain present: Node v24.21.0, npm 11.19.0, Docker 29.8.0 (daemon
  running), kubectl v1.37.0, **Helm v4.3.0**, minikube (at
  `/usr/local/bin/minikube`), Python 3.14.2, Go 1.27.1, **no Rust/cargo**.
- Hardware: x86_64, 2 vCPU, 7.8 GiB RAM, ~19 GiB free disk.
- Kubernetes: **no cluster reachable** (`kubectl cluster-info` → connection
  refused on localhost:8080). Recorded as R-18 UNVERIFIED, not blocked.

### 2. Portaldot investigation (commands executed → actual results)

All probes run 2026-10-09 in `/tmp/opencode/portaldot-probe` (outside repo;
nothing machine-level installed; all processes stopped afterwards).

1. `curl api.github.com/repos/portaldotVolunteer/Portaldot-node/contents/` →
   4 tarballs (testnet/mainnet × ubuntu/macos); testnet-ubuntu = 29,591,898 B.
2. Download + extract → `portaldot_dev`, `subkey`.
3. `./portaldot_dev --version` → `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu`.
4. `--help` → full older-generation Substrate CLI (R-02): `--dev`,
   `--chain`, `--alice…--ferdie/--one/--two`, `--validator`, `--base-path`,
   `--port/--rpc-port/--ws-port`, `--bootnodes`, `--node-key-file`,
   `--prometheus-port` (metrics on by default), `--rpc-methods`, subcommands
   `build-spec`, `purge-chain`, `key {generate-node-key, insert, inspect…}`.
5. Single-node run `--dev --alice` (ports 30343/19933/19944) → BABE blocks
   every ~6 s, peer id logged, Prometheus at 9615. **R-03 VERIFIED.**
6. HTTP RPC probes → real responses for `system_health`, `system_chain`
   ("Development"), `system_name` ("Portaldot Node"), `system_version`,
   `system_peers`, `system_localPeerId`, `system_syncState`,
   `chain_getHeader`, `state_getRuntimeVersion` (specName `portaldot`,
   specVersion **1002**, 13 runtime APIs). **R-07/R-08 VERIFIED.**
7. `build-spec --chain local --raw --disable-default-bootnode` → 1,488,964 B
   raw spec; non-raw shows `Local Testnet` / `local_testnet` / chainType
   `Local`; genesis runtime keys include babe, grandpa, staking, session,
   sudo, imOnline, balances, indices, treasury, authorityDiscovery, vesting,
   gilt, transactionStorage. **R-10 VERIFIED.**
8. **2-node network experiment** (script `/tmp/.../multinode-test.sh`):
   Alice (30353/19953/19964/9715) + Bob with
   `--bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<AlicePeer>` (30354/19954/19965/9716)
   → both `system_health.peers = 1`, peers listed with `roles: "AUTHORITY"`,
   identical best block (#7, hash `0x38ba8…7f3f`), finality progressing
   (`finalized #5` on both). **R-04 VERIFIED — multi-node local networks work.**
9. `state_getMetadata` → magic `meta`, **metadata V13** (matches ecosystem
   notes). **R-15 VERIFIED.** (First attempt failed: `--tmp` + `--base-path`
   are mutually exclusive — recorded as a real constraint.)
10. `file`/`ldd` on binary → glibc dynamic x86_64 (libstdc++, libz, libgcc_s,
    libc). Docker daemon running. **R-17 PARTIALLY VERIFIED (feasible, no
    image built).**
11. Stop test → `kill` (SIGTERM) both nodes; `pgrep -x portaldot_dev` → no
    orphans. **R-09 PARTIALLY VERIFIED (clean exit observed; DB-flush proof
    pending T-1.4).**
12. Docs cross-check: official readthedocs (local test, system RPC, staking
    and session extrinsics, imOnline events, chain info) fetched; staking
    surface is full modern NPoS (R-12), session exposes `setKeys`/`purgeKeys`
    (R-13), imOnline exposes `AllGood`/`HeartbeatReceived`/`SomeOffline`
    (R-14). Ecosystem prior art (`portaldot-dev-kit`, a different hackathon
    project) documented for its V13 signing quirk + DB-wedge note (R-16); no
    code reused.

### 3. Problems encountered

- `pkill -f "<pattern>"` matched the invoking shell itself and killed the
  probe script → switched to `pkill -x portaldot_dev` (exact name). Noted for
  test-harness design.
- `--tmp` + `--base-path` mutual exclusion surfaced via a clap error →
  recorded; engine must never emit both.
- Backgrounded `&&`-chains lost variable scope in shell probes → switched to
  standalone script files for multi-step experiments.

### 4. Decisions made

DEC-001…DEC-010 recorded in `docs/DECISIONS.md` (TS monorepo; in-process CLI
engine; REST+WS; argv-only process orchestration; SQLite; deployment adapter
interface; TOFU binary hashes; test-network gate for failure ops; no
fabrication; phased evidence-based delivery).

### 5. Deliverable status (Phase 0 checklist)

| Deliverable | Status |
|---|---|
| Workspace/environment report | DONE (this log + §1) |
| Portaldot capability matrix w/ statuses | DONE (`docs/TECHNICAL_RESEARCH.md`, R-01…R-20) |
| Initial architecture proposal | DONE (`docs/ARCHITECTURE.md`) |
| Stack recommendation + justification | DONE (DEC-001 + ARCHITECTURE §10) |
| Prioritized implementation plan (IDs, ACs) | DONE (`docs/IMPLEMENTATION_PLAN.md`, T-1.1…T-7.5) |
| Risk register | DONE (`docs/RISKS.md`, RSK-01…RSK-20) |
| Documentation structure | DONE (9 docs + README) |
| Root-level AGENTS.md | DONE |
| Unresolved questions + exact experiments | DONE (ARCHITECTURE §12, RESEARCH "Next step" per entry, plan spike note) |
| Phase 1 task specification | DONE (plan Phase 1 table + "Exact next action" below) |

### 6. Remaining work / exact next step

**STOP after Phase 0** (per instruction). Next session starts Phase 1 with
**T-1.1**: scaffold the npm-workspaces monorepo per `docs/ARCHITECTURE.md` §11
(packages/engine, packages/cli, apps/api, apps/web), TS strict config, vitest,
`npm run build` + `npm test` green — then commit as a reviewable unit and
update this log.

---

## 2026-10-09 — PHASE 1: Foundation & Node Lifecycle Core (T-1.1…T-1.9)

**Phase/Task IDs**: T-1.1 (scaffold), T-1.2 (types+StateStore), T-1.3
(BinaryManager), T-1.4 (NodeProcessManager), T-1.5 (PortaldotRpcClient),
T-1.6 (NetworkService), T-1.7 (CLI), T-1.8 (API), T-1.9 (suite+docs).
**Status**: all VERIFIED (see `docs/IMPLEMENTATION_PLAN.md` + note † there).

### 1. What was built

Runnable npm-workspaces monorepo (TS 5.9 strict, eslint 9 flat config, vitest):

- **`packages/engine`** — the single shared operations engine (DEC-002):
  - `types.ts`/`errors.ts` — typed models (NetworkDefinition, NodeRecord,
    OperationResult, RpcSnapshot incl. head + **finalized**) and the
    `KaizenError` taxonomy (structured code/message/details).
  - `state/store.ts` — SQLite (`node:sqlite` DatabaseSync, zero native deps)
    with schema migrations (v1), networks/nodes/operations CRUD, operation→
    network linking.
  - `binary/manager.ts` — TOFU SHA-256 manifest, idempotent `setup()` with
    cached-tarball re-verification, tar extraction with layout validation,
    `--version` smoke check; frozen platform URL table (linux-x64,
    darwin-x64/arm64; win32 → `UNSUPPORTED_PLATFORM` with WSL guidance).
    Never downloads at startup — explicit setup only.
  - `process/` — probe-bind PortAllocator (31000–34999 default),
    `buildNodeArgs`+`assertSafeArgs` (argv arrays only; forbids `--tmp`,
    external RPC hosts per DEC-004/DEC-008), NodeProcessManager (settle
    check → `STARTUP_FAILED` + log tail; pid files; `STALE_PROCESS`;
    SIGTERM→SIGKILL; **intrinsic crash detection**; **cross-process adopted
    stop** via persisted pid/pidfile; `unref()` + log-fd stdio so nodes
    survive CLI/API exit, daemon-style).
  - `rpc/client.ts` — `@polkadot/api` WsProvider client: typed snapshots
    (chain/name/version/health/sync/header/runtime incl. spec 1002),
    best-effort `system_peers` + raw `system_localPeerId` + finalized head,
    head subscriptions, structured `RPC_CONNECTION_FAILED`/`RPC_ERROR`.
  - `network/service.ts` — create (key generation, chain-spec generation for
    two-node, static bootnodes from real peer ids), start (health-gated via
    HTTP `system_health`, rollback on failure), stop (dependent-first order,
    adopted stops), inspect (live snapshot per node), remove (running-guard),
    full operation history.
  - `engine.ts` — `createEngine()` factory wiring store/manager/networks and
    crash → DB-status detection.
- **`packages/cli`** — commander CLI over the same engine (in-process):
  `setup`, `status`, `network create|list|start|stop|status|remove`, `--json`
  everywhere, structured errors, meaningful exit codes.
- **`apps/api`** — Fastify + Zod: REST mirroring engine ops, structured
  error envelopes, WS `/api/events` broadcasting engine events, bound to
  127.0.0.1:4310. **No setup endpoint** (binary acquisition stays a CLI
  decision). Routes registered in a plugin scope so `@fastify/websocket`'s
  `onRoute` hook applies (see bug 6 below).
- **`apps/web`** — Phase 1 ships only the Vite+React scaffold page (real UI
  is Phase 2+; nothing mocked, nothing faked — DEC-009).

### 2. Verification (commands → actual results)

- `npm run typecheck` → clean; `npm run lint` → clean; `npm run build` →
  clean (engine→cli→api→web).
- `npm test` → **32/32 unit tests pass** (6 files).
- `KAIZEN_TEST_LIVE=1 npm run test:integration` (final run) →
  **16/16 live tests pass, 5/5 files, 96 s**:
  - `binary.int` (1): fresh download+verify+smoke; idempotent re-run.
  - `process.int` (4): start/health/duplicate-refusal/SIGTERM-stop with no
    orphans; invalid flag → `STARTUP_FAILED` + log tail; cross-process
    adopted stop (second manager instance, idempotent re-stop); external
    SIGKILL → `crashed` + SIGKILL recorded + restart recovers chain DB
    (height before ≥ after restart).
  - `rpc.int` (5): real snapshot (Development, `portaldot@1002`, real
    `12D3KooW…` peer id, finalized ≤ head, peers `[]` on solo dev);
    subscription delivers advancing heads; dead port → structured
    `RPC_CONNECTION_FAILED`; `readSnapshot` one-shot; node stop+restart →
    same client reconnects and reads resume (T-1.5 restart AC).
  - `network.int` (2): single-node lifecycle incl. finalized read +
    history + no orphans; **two-node: `peers ≥ 1` both, bidirectional
    peer-id cross-check, AUTHORITY roles, identical best hash, equal
    progressing finalized heights** (T-1.6 "peers and finalizes" AC).
  - `api.int` (4): health, Zod 400 envelope, real create/list delegation,
    WS hello + engine events.
- CLI smoke (13/13 steps, `/tmp/opencode/cli-smoke.sh`): fresh setup
  download → status → create → duplicate/invalid-name errors with correct
  exit codes + JSON envelope → list → start → status (real RPC height/
  peers/spec; `process=running` cross-process) → parseable `--json` →
  stop (adopted) → remove → empty list.
- Hygiene: `pgrep -ax portaldot_dev` after every suite → **no orphans**;
  secret/key scan over the diff → nothing (only doc comments); no `.kaizen/`,
  `*.db`, `*.nodekey`, or `dist/` tracked (`.gitignore` verified).

### 3. Problems encountered (all found BY the live layer, fixed, tested)

Recorded in `docs/TESTING.md` §4.4 with details; the significant ones:
`withTimeout` void-resolution broke every "graceful stop" check (false
`STOP_TIMEOUT` on success); `WsProvider(url, false)` never connects;
`key generate-node-key` prints peer id to stderr; `api.provider` is
undefined on @polkadot/api v17 (raw RPC via held provider reference instead);
`isPidAlive(0)` has process-group kill semantics; websocket routes registered
before the plugin loads are silently non-websocket; **short-lived CLI
processes could not stop daemon nodes, and the failed stop nulled the pid,
which let `remove()` delete a live node's data dir** (adopted stop + keep-
record-on-failure); crash-vs-stopped state depended on an `onExit` hook.

### 4. Decisions made (new; DEC-001…DEC-010 unchanged)

- Child stdio → log file descriptors + `child.unref()`: nodes are daemons
  that outlive CLI/API processes; stop works across processes via persisted
  pid (proven by test). Rationale recorded in code comments + TESTING §4.4.
- `node:sqlite` DatabaseSync chosen over better-sqlite3 (zero native deps,
  Node 24 built-in); TS pinned 5.9.3 (TS 7 too new for the toolchain).
- Engine accepts `binaryCacheDir` so tests share one binary cache per machine.
- Node keys are pre-generated at network **create** for both presets (stable
  peer id recorded in bootnodes; key material never in DB/logs/argv).
- Runtime-stall ("alive but wedged") detection split to T-2.4 monitoring
  (note † in IMPLEMENTATION_PLAN); Phase 1 covers crash/startup-failure
  detection.

### 5. Docs updated

`docs/IMPLEMENTATION_PLAN.md` (T-1.1…T-1.9 → VERIFIED + note †),
`docs/PROGRESS.md` (this entry), `docs/TESTING.md` (new §4: suite layout,
results, caught-bug ledger, skip semantics), `docs/TECHNICAL_RESEARCH.md`
(R-06 → VERIFIED: WS proven via @polkadot/api; R-04 evidence extended with
engine-native two-node convergence), `README.md` (Phase 1 status + real
install/CLI quickstart).

### 6. Remaining work / exact next step

**STOP after Phase 1** (per instruction). Next session starts Phase 2 with
**T-2.1**: inspect the Local Testnet genesis authority set from a real
exported spec (flip R-05), define topology presets as data — then T-2.2
ChainSpec service + T-2.3 4-validator/validator+fullnode presets, T-2.4
MonitoringService, T-2.5 web app scaffold over the existing WS event API.

## 2026-10-10 — PHASE 2A: Topology Engine & Live Monitoring (T-2.1…T-2.4, T-2.8, T-2.9)

**Phase/Task IDs**: Phase 2A (split from Phase 2; UI tasks T-2.5…T-2.7 stay
NOT STARTED as Phase 2B — stopped here per instruction).
**Files created/modified**: engine `src/types.ts`, `src/errors.ts`,
`src/index.ts`, `src/engine.ts`, `src/events/bus.ts`, `src/state/store.ts`,
`src/network/service.ts`, NEW `src/network/topologies.ts`, NEW
`src/network/chainspec.ts`, NEW `src/monitor/{sampler,health,service}.ts`;
tests NEW `test/{topologies,chainspec,monitor,service}.test.ts` +
`test/store.test.ts`; API `apps/api/src/server.ts`; CLI
`packages/cli/src/index.ts`; live tests NEW
`test/integration/{topology,monitor}.int.test.ts` + extended
`test/integration/api.int.test.ts`; docs PLAN/RESEARCH/DECISIONS/RISKS/
ARCHITECTURE/TESTING/README + this entry + NEW `docs/PHASE_REPORT.md`.

### 1. T-2.1/T-2.2 live spike (before implementation; artifacts /tmp/opencode/t21)

- Local Testnet plain spec seeds exactly **two** genesis authorities (Alice
  `5GrwvaEF…`, Bob `5FHneW46x…`, `staking.validatorCount=2`); Charlie/Dave/Eve
  are funded in genesis balances but are NOT authorities.
- Key derivation verified by reproducing Alice's/Bob's genesis entries with
  `key inspect`: babe/imOnline/authDiscovery = sr25519(//X); **grandpa =
  ed25519(//X)**.
- Patched plain spec (4 authorities in session.keys/stakers/invulnerables,
  validatorCount=4) → `build-spec --chain <file> --raw` → live 4-node
  network: **full mesh (peers=3 on every node)**, identical genesis hash
  `0x2b9bd419…`, **all four authored blocks** (alice=36, bob=58, charlie=50,
  dave=42 after ~8 min), GRANDPA finality advancing (finalized 12 vs best 14).
- 5th keyless full node: peers=4, synced to network best (95=95),
  `isSyncing=false`, 0 blocks authored.
- R-05 and R-10 flipped to VERIFIED with this evidence.

### 2. Implementation (engine owns everything; CLI/API stay thin)

- `topologies.ts`: 5 presets as data (single/two-node/four-validator/
  validator-fullnode custom) + pure `resolveTopology()` custom validation
  (unique names, unique well-known keys for validators only, ≥1 validator,
  ≤8 nodes) — runs before any dir/port/process side effect.
- `chainspec.ts`: ChainSpecService — plain spec → typed authority patch with
  keys derived from the binary at create time (DEC-011) → raw rebuild →
  `chain-spec.genesis.json` audit sidecar; unpatched spec for topologies
  whose authorities are already in stock (alice+bob).
- `service.ts`: topology-driven create with **partial-create rollback**
  (dirs removed, ports released, no debris), ordered start/stop, per-node
  `startNode/stopNode`, `purgeChain` (refuses while any node alive; wipes
  chain DBs; keeps identity/ports/spec), expected-peers wiring.
- `monitor/`: HTTP JSON-RPC sampler (parallel single-method POSTs,
  per-method tolerance), pure `evaluateNodeHealth()` (states
  unknown/healthy/unhealthy/unavailable/stale; process liveness checked
  first — see §4.1), MonitoringService (one job per network, in-flight
  guard, unref'd timers, auto-attach/detach via `network.status` events,
  `snapshotNow()` on demand).
- `state/store.ts`: migration v4/v5 — `nodes.started_at` (sticky via
  COALESCE) and `nodes.expected_peers`; idempotent `close()`.
- `events/bus.ts`: `network.created`, `monitor.sample/health/peers/error`,
  `operation.completed` gains nodeId.
- API: custom topology body, purge/monitor/node-detail/node-start/node-stop
  routes, structured codes (404 NODE_NOT_FOUND, 409 NODE_NOT_RUNNING, …).
- CLI: `--preset` (all 5), `--nodes` custom spec, `network purge`,
  `network monitor`, `node list/get/start/stop`.

### 3. Gates (commands + actual results)

- `npm run typecheck` → clean; `npm run lint` → clean; `npm run build` → ok.
- Unit `npm test`: **81/81 pass (10 files)** (Phase 1 had 32).
- Live `KAIZEN_TEST_LIVE=1 npm run test:integration`:
  - first full run: 23/25 — two failures, both real findings (§4);
  - after fixes: api 6/6, monitor 1/1 re-run green;
  - final full run: **25/25 pass (7 files), 213 s** — topology (4-validator,
    validator+fullnode, custom, invalid-topology-no-debris,
    purge+restart-from-genesis, concurrent creation), monitor (real samples,
    crash → unhealthy, peers 1→0 transition, cleanup on stop, on-demand
    snapshot honesty), api (validation 400s, node ops, monitor honesty on a
    stopped network, purge refusal, WS typed events), plus Phase 1's
    binary/process/rpc/network suites;
  - `pgrep -ax portaldot_dev` after the suite → no orphans.
- Secret scan of `git diff` (keys/mnemonics/64-hex) → no matches; new files
  carry no key material; `.kaizen/` remains gitignored.

### 4. Bugs the new tests caught (fixed; regression-tested)

1. **Health precedence**: the process-death check ran AFTER the RPC-failure
   branch, so a never-started or dead node reported `unknown`/`unavailable`
   instead of `unhealthy` (a dead process can never answer RPC — process
   evidence must win). Fixed + unit test; live API test now sees
   `unhealthy` for non-running nodes.
2. **Stdio drain race**: `runBinaryCapture`/chainspec `run`/version smoke
   resolved on `child.on('exit')`, which can precede stdio drain — under
   concurrent key generation the peer-id line (stderr) was occasionally
   lost (`Could not parse peer id …: <empty>`). Fixed everywhere: `close`
   event + signal-aware error text. Caught by the concurrent-creation live
   test (a previously green test).
3. Earlier in-phase unit-test fixes: `lastHeadAdvanceAt` closure bug
   (health), `PromiseFulfilledResult.value` misuse (sampler), non-idempotent
   `StateStore.close()`.

### 5. Decisions made (new; DEC-001…DEC-010 unchanged)

DEC-011 (authority patching derives keys from the binary — never hardcoded
chain data), DEC-012 (monitoring = HTTP RPC sampling + pure health machine),
DEC-013 (uptime/expected-peers persisted; chain data disposable via purge),
DEC-014 (custom topology validation rules), DEC-015 (event-driven monitor
lifecycle + on-demand snapshots).

### 6. Remaining work / exact next step

Phase 2B web UI (T-2.5 scaffold → T-2.6 dashboard over the typed WS stream →
T-2.7 log tail) — deliberately NOT started; this phase stops at the engine/
API/CLI boundary per instruction. Next session begins T-2.5.

## 2026-10-12 — PHASE 2B: Web UI & Live Operations Dashboard (T-2.5, T-2.6, T-2.7, T-2.10)
**Phase/Task IDs**: Phase 2B (web UI over the Phase 2A API/engine; Failure
Lab / K8s NOT started — recorded as remaining work).
**Files created/modified**:
- `apps/web/` — NEW src tree: `api/{types,client,events}.ts`, `state/
  {useAsync.ts,EventsContext.tsx}`, `components/{Layout,States,StatusBadge,
  ConfirmDialog,OperationButton,fmt}.tsx|ts`, `pages/{Overview,Networks,
  CreateNetworkForm,NetworkDetail,NodeDetail,Events}Page.tsx`, `App.tsx`,
  `main.tsx`, `styles.css`; tests NEW `src/**/*.test.{ts,tsx}` +
  `src/test-utils/{fake,fixtures,render}`; `index.html`, `tsconfig.json`,
  `vite.config.ts`, `package.json` (react-router-dom, testing-library, jsdom).
- `apps/api/src/server.ts` — NEW `GET …/nodes/:nodeId/logs` (Zod query);
  node-detail route now samples on demand when no snapshot is stored (DEC-017).
- `packages/engine/src/network/service.ts` — NEW `nodeLogTail()` (read-only
  tail of a node's captured log via the engine's existing `readLogTail`).
- root `package.json` (typecheck now covers `apps/web`), `vitest.config.mts`
  (web tests included), `test/integration/webclient.int.test.ts` (NEW live),
  `test/integration/api.int.test.ts` (contract update for DEC-017),
  `docs/{ARCHITECTURE,DECISIONS,IMPLEMENTATION_PLAN,RISKS,TESTING,README}` +
  this entry + NEW `docs/PHASE_REPORT.md` (2A report archived to
  `docs/reports/PHASE_02A_REPORT.md`).

### 1. What was built (screens + integration)

Five screens, all rendering real API/WS data only (DEC-009), desktop +
mobile responsive, keyboard/focus styles, confirmation modals for
purge/remove:

- **Overview** — fleet metrics DERIVED from `GET /api/networks` +
  per-running-network `GET …/monitor` (networks/running/unhealthy/total
  nodes), per-network health rollups, recent event feed, empty/loading/
  error/disconnected states.
- **Networks** — list (name/topology/status/node count/created) with client
  filter, create form for all 5 presets incl. a custom node editor; server
  validation errors (code + per-field issues) rendered verbatim.
- **Network detail** — identity/persistence facts, nodes table (role/status/
  key/ports/expected peers), live monitoring table (health + reasons, peers
  n/expected, best/finalized, sync, uptime, sample age; `unreachable` cells
  when RPC is down; "monitoring runs while running" note when stopped),
  lifecycle controls (start/stop; purge/remove behind confirm + disabled
  while running), per-network recent events.
- **Node detail** — identity/process (pid, started, ports, bootnodes), live
  chain data with explicit `RPC unreachable` state (error text shown, no
  invented numbers), connected-peers table, real log tail (auto-refresh
  while running), node start/stop.
- **Events** — app-wide feed from the single WS (kind filter, timestamps,
  ids, payload disclosure), reconnect banner that states missed events are
  NOT replayed, clear-view control.

Integration layer: one typed `KaizenApiClient` (base URL, timeouts — 300s
start / 120s stop, structured `ApiError` with issues) + one
`KaizenEventStream` in React context (capped backoff + jitter reconnect,
last-unsubscribe teardown, `resync` → pages refetch REST). Engine models
imported `import type`-only. Bounded polling: monitor 5s (running only),
logs 10s (running only), overview 10s (active only), networks 3s
(starting/stopping only). Browser never launches processes (FR-1).

### 2. Gates (commands + actual results)

- `npm run typecheck` → OK (now includes `tsc -p apps/web --noEmit`).
- `npm run lint` → OK (0 problems).
- `npm run build` → OK; web bundle 304.15 kB (93.28 kB gzip). Rolldown
  emits a benign `use client` directive warning from react-router — not
  our code, bundle works.
- `npm test` → **113 passed (17 files)** = 81 pre-existing (unchanged) +
  32 NEW web tests (client, events stream, 6 page/component suites).
- `KAIZEN_TEST_LIVE=1 npm run test:integration` → full suite
  **30 tests / 8 files, 224.79s**: 1 failure was api.int asserting the
  pre-DEC-017 node-route contract (`sample: null`); test updated to the
  new contract and re-run green (api.int 6/6, webclient 5/5). Final state:
  all 8 live files pass.
- `pgrep -ax portaldot_dev` after suites → no orphans.
- CLI smoke not re-run: CLI untouched this phase; engine change is
  additive-only (`nodeLogTail`) and all engine tests are green.

### 3. Real-backend verification vs component tests (explicit boundary)

`test/integration/webclient.int.test.ts` (LIVE) runs the ACTUAL
`KaizenApiClient` + `KaizenEventStream` — the exact code the browser
executes — against a real API server + engine + real `portaldot_dev`
network: health & structured validation errors through the client; network
create + `network.created` observed on the UI's stream; health-gated start;
monitor shows `healthy` with peers 0/0, real head, `0x…` genesis; values
CROSS-CHECKED against an independent raw RPC read (head within drift,
peer count equal, real `12D3KooW…` peer id); real log bytes via the new
logs endpoint; stop → honest `unhealthy`/unreachable; typed
`network.status running/stopped` events seen; cleanup via client.
**Boundary**: jsdom component tests verify rendering/state logic with
fixtures only; there is NO real-browser E2E in this phase (no Playwright in
the repo) — recorded as RSK-23, not claimed as verified.

### 4. Bugs the new tests caught (fixed)

1. **Node-detail route returned null sample/health** in the window between
   start and the first stored snapshot, even for a verifiably running node
   (caught LIVE by webclient; invisible to mocked tests). Fixed: route now
   uses `getLatest() ?? snapshotNow()` like the monitor route (DEC-017);
   api.int contract updated accordingly.
2. **Client error classification**: a failed request with a non-JSON body
   reported `BAD_RESPONSE` instead of `HTTP_<status>`; fixed so status-based
   classification wins for non-2xx (unit test).
3. **Event stream teardown**: `manuallyClosed` made the socket unreopenable
   after StrictMode's subscribe→cleanup→subscribe cycle; replaced by
   subscriber-count-based teardown (unit-tested: reconnect works, no leak).
4. **Status listener echo**: `onStatus` emitted the initial state twice when
   `connect()` produced a transition; fixed (unit-tested exact sequence).

### 5. Decisions made (new; DEC-001…DEC-015 unchanged)

DEC-016 (thin typed web client over existing API; single shared WS with
resync-refetch; engine types import-type-only; bounded polling, never
optimistic), DEC-017 (node detail samples on demand when no snapshot is
stored).

### 6. Remaining work / exact next step

- Not in this phase (per instruction, NOT started): Failure Lab/scenarios
  (Phase 3), incident timelines (Phase 4), validator transactions (Phase 5),
  Docker/K8s deployment (Phase 6), real-browser E2E (RSK-23).
- UI refinements deferred: WS log streaming with since-timestamp tailing
  (DEC-016 alternative), pagination for very large event feeds.
- Next: Phase 3 — start with T-3.1 (failure-mechanism feasibility spike,
  DEC-008 gate intact).

## 2026-10-12 — PHASE 3A: Fault Mechanism Study (T-3.1)

**Phase/Task IDs**: Phase 3A / T-3.1 only. FailureInjector, scenario
engine, and Failure Lab UI were explicitly NOT started (T-3.2 next). All
faults ran against freshly created disposable Kaizen-managed networks with
`designatedTest === true` verified before every fault (DEC-008 intact).
Privileged experiments (iptables/netns) ran only after explicit operator
authorization (DEC-018).
**Files created/modified**:
- `test/experiments/t31-spike.mjs` — NEW standalone experiment harness
  (imports built engine helpers only; argv-only spawns; SIGSTOP-PID
  registry; firewall/netns/cgroup rollback registered on every exit path;
  emergency cleanup on SIGINT/SIGTERM). Subcommands: `a-pause`, `b-peer`,
  `b-peer-reserved`, `c-partition[-reserved|-mdns]`, `c-iptables[-cgroup]`,
  `c-netns`, `d-terminate`, `rpc-probe`.
- `eslint.config.mjs` — Node globals declared for `test/**/*.mjs` (the new
  harness tripped `no-undef` on `process`/`console`/`fetch`/timers).
- `docs/TECHNICAL_RESEARCH.md` — NEW entry **R-22** (capability matrix +
  environment facts + reproduction), summary matrix rows R-21/R-22.
- `docs/DECISIONS.md` — NEW **DEC-018** (kernel-level fault operations:
  authorization, scope, rollback verification).
- `docs/{IMPLEMENTATION_PLAN,RISKS,ARCHITECTURE,TESTING}` updated (see §5),
  `docs/PHASE_REPORT.md` rewritten (2B report archived to
  `docs/reports/PHASE_02B_REPORT.md`).

### 1. Mechanisms proven (evidence in `/tmp/opencode/t31-*.log`, matrix in R-22)

- **A — pause/resume (VERIFIED)**: `t31-a-full.log`. SIGSTOP on alice →
  PID alive, RPC times out → health `unknown` → `unavailable`; bob
  half-rate production (head 1→3/36 s), finality stalled (2/2), libp2p
  connection held (peers 1/1). SIGCONT → RPC <3 s, sync 0→4 in 3 s,
  finality resumed to #5 in ~20 s, both healthy, no restart.
- **B1 — reserved-peer RPC on a normal connection (PARTIAL, negative)**:
  `t31-b.log`, `t31-b2.log`. Bare peer-id add fails (`2002
  MultiaddrParse`), multiaddr add/remove changes `system_reservedPeers`,
  but the live connection never dropped (60 s, 20 samples, both sides,
  both runs). This RPC is set-membership only.
- **B2 — disconnect on a reservation-bound connection (VERIFIED)**:
  `t31-b3.log`. On a `--reserved-only` node, `removeReservedPeer(alice)`
  → reserved set emptied, victim peers 1→0 at t=0 s, alice lost it by
  t=3 s, sustained 60 s.
- **C1 — proxy cut alone (PARTIAL, negative)**: `t31-c2/c3/c5.log`.
  `ss` proved the proxied leg carried the connection and the group-kill
  severed it instantly (0.014 s) — but the mesh reconverged in ~1 s with
  mDNS on and ~15 s with `--no-mdns` (identify-learned direct addresses).
  mDNS (default ON for non-dev chains) bypasses bootnode wiring entirely.
- **C2 — reserved-only + proxied reserved-nodes, unprivileged (VERIFIED)**:
  `t31-c4.log`. Victim peers → 0 at t=0.006 s, sustained 90 s; alice/bob/
  keep mesh intact; reconnect on proxy restore.
- **C3 — static port-scoped iptables (PARTIAL, negative)**: `t31-f2/f4.log`.
  Isolation until ~50 s, then escape via fresh ephemeral ports and IPv6
  (`[::1]`); `-i lo` additionally missed eth0 (`10.0.4.11`) legs.
- **C4 — ip{,6}tables + cgroup process scoping (VERIFIED)**: `t31-f6.log`.
  Both families, no interface scoping: port rules + per-established-socket
  seals + `OUTPUT -m conntrack --ctstate NEW -m cgroup --path /t31-*`
  with the victim in that cgroup. Alice dropped bob at 50 s; sustained
  t=55→145 s (alice={keep}, keep={alice}, victim peers=0, victim RPC up);
  reconverge ≤10 s after removal; firewall (v4+v6) byte-identical to
  baseline; cgroup removed (`leftovers: []`); zero delete failures.
- **C5 — netns + veth (VERIFIED)**: `t31-g.log`. Dedicated `10.77.53.0/24`
  link; host-side link-down → ns peers=0 with ns RPC up and **ns head
  frozen at 1 while alice advanced to 16**, zero host `ss` legs, alice↔bob
  intact; link-up → reconnected ≤5 s; netns+veth removed (verified).
- **D — terminate + restart (VERIFIED)**: `t31-d.log`. Engine stop →
  `unhealthy` "process is not running (status: stopped)" — distinct from
  pause's `unavailable`; start → new PID, peers back <1 s, chain resumed
  0→3 → finality #1, final heads 10→12 healthy.

### 2. Commands actually run (with results)

- Experiments: `KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode
  node test/experiments/t31-spike.mjs <subcommand>` — 10 recorded runs
  (a×1, b×3, c×5, d×1, plus `rpc-probe` inventory).
- Micro-tests isolating kernel semantics: cgroup rule (BLOCKED + counter
  incremented), `--ctdir ORIGINAL` (counter 0, bytes flowed → inert).
- Gates: `npm run typecheck` ✅, `npm run lint` ✅ (after the eslint globals
  fix), `npm run build` ✅, `npm test` ✅ **113/113 (17 files)**,
  `KAIZEN_TEST_LIVE=1 npm run test:integration` ✅ **30/30 (8 files,
  226 s, real `portaldot_dev 2.0.0`)**.
- Leak checks after every privileged run: `pgrep portaldot_dev` none,
  `socat` none, `ip netns list` empty, `vt31a` gone, iptables/ip6tables
  INPUT/OUTPUT empty (Docker chains untouched), no `/sys/fs/cgroup/t31-*`,
  no leftover data dirs.

### 3. Problems encountered (honest record)

1. **Harness bugs fixed during the spike**: missing `engine.networks.start()`
   in setup; `system_peerId` → `system_localPeerId`; `key generate-node-key`
   prefix + peer-id regex; `engine.binaries.nodePath()`; single-node preset
   has no spec file (C switched to two-node + keyless manual peers).
2. **socat listener kill left forked children** holding established
   connections → fixed with `detached:true` + process-group SIGKILL.
3. **Firewall rule leak (incident, fixed)**: the first `-D` construction
   dropped the chain name (`iptables -D 1 …`) so deletion failed silently
   and rules remained. Detected by the harness's own final-state log, the
   rules were deleted manually (verified empty) and the harness now builds
   exact `-D <chain> <rule-spec>` commands and logs every delete failure.
4. **Two kernel surprises that invalidated rule sets** (documented in R-22):
   `--ctdir ORIGINAL` inert (0 packets matched) and IPv6/eth0 bypasses of
   IPv4/loopback-scoped rules. Only the empirically re-verified rule set
   (C4) is claimed.
5. **Live-process cgroup move-back fails EBUSY** in this container →
   cleanup kills nodes first, then removes the cgroup (verified empty).

### 4. Verification boundary (no overclaiming)

- "Partition succeeded" claims are only made where the connectivity change
  AND unaffected connectivity were both observed (peer sets on every node +
  `ss` + head/finality progression), never from the target's silence.
- No claim is made about monitor/UI behavior during faults — health values
  cited are direct RPC reads (`system_health`, `system_peers`).
- Long-horizon (>90 s) reconvergence and partial-authority finality under
  isolation were not measured (RSK-12 stays open).

### 5. Decisions & doc status flips

- **DEC-018** added (kernel-level fault operations: authorization, narrow
  scope, rollback verification).
- **RSK-09** → MITIGATED (mechanisms evaluated empirically; two unprivileged
  and two privileged routes proven, limitations recorded).
- **RSK-24** added (injector bypass via discovery/address leakage — mDNS,
  ephemeral ports, dual-stack/multi-homed — with the R-22-derived
  mitigations).
- ARCHITECTURE §6 gains the fault-injection lifecycle note; TESTING §10
  records reproduction commands; T-3.1 → VERIFIED in IMPLEMENTATION_PLAN.

### 6. Remaining work / exact next step

- Stop here per instruction: FailureInjector/scenario engine NOT started.
- Next: **T-3.2** — FailureInjector with the DEC-008 gate, dry-run preview,
  timeouts and guaranteed cleanup, using R-22's recommended unprivileged
  defaults (SIGSTOP, engine stop/start, reserved-only+proxy) and DEC-018's
  discipline for any kernel-level fault; re-verify each chosen mechanism
  inside the injector's own lifecycle.

---

## 2026-10-12 — PHASE 3B: FailureInjector Foundation (T-3.2)

### 1. What was built

A typed, safely-gated FailureInjector inside the shared engine
(`packages/engine/src/fault/`), integrated via `engine.faults` — the same
service both frontends will consume (the Failure Lab UI is explicitly NOT
built here; T-3.3+ and T-3.6 own scenarios/CLI/UI).

- **Fault domain model** (`fault/types.ts`, `fault/lifecycle.ts`): 11-state
  machine (`requested → validating → (rejected | ready → executing →
  verifying → cleaning-up → completed | failed | cancelled |
  cleanup-failed)`); illegal transitions throw; results separate the claims
  applied / effectObserved / faultRemoved / recovered / recoveryVerified
  (never one "success" flag) with structured before/apply/effect/remove/
  recovery evidence (timestamps, pids, RPC observations).
- **Narrow adapters** (`fault/adapter.ts`, `fault/adapters/*`): each declares
  type, privileges, preflight checks, bounded execution, expected effect,
  verification, timeout behaviour, cleanup, and failure semantics. NO
  generic shell/signal/executable/firewall surface exists.
  - `pause` — SIGSTOP/SIGCONT on a re-verified managed PID (R-22 A).
  - `terminate` — engine `stopNode`/`startNode`; restore verified with a NEW
    pid (R-22 D).
  - `peer-disconnect`, `partition` — registered as explicit BLOCKED adapters:
    typed `FAULT_NOT_SUPPORTED` results with precise unblock paths (reserved-
    only topology wiring; DEC-018 operator authorization); the R-22 negative
    mechanisms are never substituted.
- **Injector** (`fault/injector.ts`): dry-run is the default surface;
  `execute()` is a separate explicit action that REVALIDATES the whole
  boundary with fresh reads — DEC-008 `designatedTest` + local chain, node ∈
  network, engine-managed running process, stable identity (pid +
  `kaizen-node.pid` agreement — reused/ambiguous processes are refused, never
  signalled), one active fault per node, quarantine check. Bounded durations
  + per-step timeouts (wrap backstop above each adapter's own bound);
  cancellation exits holds promptly and ALWAYS runs cleanup; cleanup-failed ⇒
  honest `inconclusive` outcome + high-severity `fault.cleanup-failed` event
  + target quarantine until `reconcile()` proves the effect gone;
  `engine.close()` cancels in-flight faults and SIGCONT-sweeps pause records.
- **Audit trail**: SQLite `faults` table (migration 6–8, schemaVersion 8) —
  accepted, rejected, executed, verified, cleaned-up requests all recorded
  with actor, state, plan, preflight report, evidence, error; every
  transition persisted AND emitted as `fault.state`; operations table rows
  (`fault.execute`) too. Evidence passes through key-aware redaction.
- **API surface** (`apps/api/src/server.ts`): `POST …/faults/preflight`,
  `…/dry-run`, `…/execute` (requires literal `mode:"execute"`), `GET
  …/faults`, `GET /api/faults/:id`, `…/cancel`, `…/reconcile`; Zod-validated;
  403 (gate), 404, 409 (conflict/unsupported) mappings; fault events flow
  through the existing typed WS fanout.

### 2. Mechanism statuses (final)

| Mechanism | Status | Basis |
|-----------|--------|-------|
| pause | VERIFIED (implemented + live re-verified through the injector) | R-22 A + `faults.int.test.ts`: test-side polling observed the outage ≥5 s and recovery; same pid; chain resumed |
| terminate | VERIFIED (implemented + live re-verified) | R-22 D + live: old pid dead, NEW pid serving RPC, peers reconverged, head advanced |
| peer-disconnect | BLOCKED (adapter registered, typed unsupported) | R-22 B1/B2: only `--reserved-only` targets disconnect; no topology produces them and spawn mode is not persisted on NodeConfig — unblock path recorded (live: REST execute → 409) |
| partition | BLOCKED (adapter registered, typed unsupported) | R-22 C2 (needs same wiring) / C4/C5 (need DEC-018 operator authorization + privileged path that T-3.2 deliberately does not implement) (live: REST execute → 409) |

### 3. Gates (commands + actual results)

| Command | Result |
|---------|--------|
| `npm run typecheck` | pass (engine, cli, api, web) |
| `npm run lint` | pass |
| `npm run build` | pass |
| `npm test` | **136/136 passed** (18 files, 68 s) — 113 prior + 23 new fault unit tests |
| `KAIZEN_TEST_LIVE=1 npm run test:integration` | **35/35 passed** (9 files, 268 s) — 30 prior + 5 new fault live tests, real `portaldot_dev 2.0.0` (sha256 `9df4d6332e84…`) |
| post-suite hygiene | no orphan `portaldot_dev`, no netns, no t31/flt firewall rules (checked) |

### 4. Bugs the new tests caught (fixed; regression-tested)

1. Adapter preflight check failures were recorded but did NOT add to
   `blockingReasons` — a pause could have executed with an unreachable
   baseline. Fixed: adapter checks block like gate checks.
2. Rejection codes collapsed to `FAULT_NOT_ALLOWED` — conflicts and blocked
   mechanisms now map to `FAULT_CONFLICT` / `FAULT_NOT_SUPPORTED`.
3. Error paths jumped straight to terminal states from `executing`/
   `verifying` (illegal transition, state machine caught it). Fixed: every
   terminal transition routes through `cleaning-up`.
4. `persist()` dropped the `reconciled` flag — quarantine could never be
   released. Fixed + tested.
5. The wrap timeout equaled the adapters' internal poll budget and raced it
   (spurious `OPERATION_TIMEOUT` on legitimate cleanup-failure paths). Fixed:
   wrap = adapter bound + 3 s backstop.
6. `redactDeep` scrubbed string values but not secret-NAMED keys
   (`{ mnemonic: "…" }` survived). Fixed: key-aware redaction.
7. `listFaults` ignored `nodeId` when `networkId` was also set (API filter
   mismatch). Fixed before it could ship.

### 5. Decisions made (new; DEC-001…DEC-018 unchanged)

- **DEC-019** — injector boundary: engine-internal ops on DEC-008 targets;
  dry-run default; REST execution consistent with the existing loopback-trust
  model (equal-or-lesser power to stop/purge; JSON-only + no CORS blocks
  browser-page invocation); privileged fault execution deliberately NOT
  implemented until an operator-authorization model exists; any future
  non-loopback binding requires authorization first (RSK-26).
- **RSK-25** (cleanup-failed pause needs operator reconciliation — mitigated
  by quarantine/reconcile/shutdown-sweep), **RSK-26** (loopback API auth
  posture), **RSK-27** (fault-record retention) added; **RSK-24** mitigation
  updated (injector refuses the bypass-prone mechanisms).

### 6. Remaining work / exact next step

- Stop here per instruction: Failure Lab UI, scenario engine (T-3.3/T-3.4),
  diagnostics, recovery orchestration (T-4.4), validator ops, and K8s are
  NOT started.
- Next: **T-3.3** — scenario model + authoring (ordered actions, delays,
  conditions; CRUD + validation) building on `engine.faults` +
  `engine.networks` operations; keep the same dry-run/gate discipline.

## 2026-10-14 — PHASE 3C: Scenario Model & Authoring Foundation (T-3.3)

### 1. What was built

The Failure Lab's authoring foundation in the shared engine
(`packages/engine/src/scenario/`), surfaced as `engine.scenarios` with a
minimal REST surface. Everything here is DATA + VALIDATION: there is no
execution path anywhere — CRUD and validate never touch a process, never
emit a fault event, never create a fault record (asserted by tests), and a
saved scenario never auto-runs. Scenario execution is T-3.4 (ScenarioEngine)
and the Failure Lab UI is T-3.6; neither was started.

- **Scenario model** (`scenario/types.ts`): versioned
  (`SCENARIO_SCHEMA_VERSION = 1`) definitions with stable ids
  (`scn-…`), name/description/tags, explicit target requirements
  (designatedTest enforced true — DEC-008; optional preset/minNodes/
  capabilities), ordered steps (stable `step-…` ids, explicit `order` =
  array position), typed operations, bounded delays
  (0..300 000 ms), per-step timeouts (5 s..15 min; a pause step's timeout
  must cover its hold + 60 s cleanup/recovery headroom), typed
  pre/postconditions, and explicit failure/cancellation semantics as
  persisted enums (`onPreconditionFailed: skip-step|abort-run|cancel-run`,
  `onStepFailed: abort-run|continue|cancel-run`,
  `onVerificationInconclusive: fail-step|warn-and-continue`,
  `onStepTimeout: fail-step|cancel-run`, and the fixed safe pair
  `onCleanupFailed: cancel-run` / `cancellation: cleanup-then-stop`).
  Conditions are typed inspectable data — never executable strings — with
  per-kind evaluability: `rpc-reachable`, `process-state`, `health-state`,
  `peers`, `syncing`, `chain-progress`, `recovery-verified` are supported;
  `finality-progress` and `runtime-event` are declared but marked
  `planned` and REJECTED by validation (never pretended to be checkable).
- **Safe operation registry** (`scenario/operations.ts`) — descriptive
  only, built at runtime from the injector's new
  `describeMechanisms()` (static `AdapterSupport` added to each adapter;
  blocked adapters' preflight now reads the same reason/unblock consts —
  single source of truth). `pause`/`terminate` = supported;
  `peer-disconnect`/`partition` = BLOCKED with the adapters' unblock paths
  verbatim (never shown executable); `node-restart` = planned. Each
  definition exposes display metadata, strict Zod config schema, required
  target capabilities, safety flags (designatedTest required, DEC-018
  authorization for privileged), timeout envelope, and supported
  conditions. No arbitrary shell/signal/firewall/executable surface exists.
- **Deterministic validation** (`scenario/validate.ts`) — pure (no clock,
  no store, no UI); identical input + registry ⇒ byte-identical structured
  `ScenarioValidationResult` (stable code, severity, path, message,
  remediation; no timestamps inside). Catches: unknown/blocked/planned
  operations, invalid/strict-config violations, missing fault preconditions,
  missing-postcondition warnings, contradictory/impossible conditions
  (opposite booleans, disjoint state sets, unsatisfiable peer bounds,
  stopped-but-RPC-reachable, recovered-but-RPC-down), non-evaluable
  condition kinds, condition/label/timeout/delay bounds,
  `TIMEOUT_TOO_SHORT_FOR_HOLD`, worst-case duration > 30 min, step id and
  ordering mistakes, designatedTest=false, capability gaps (severity tracks
  operation status: error for supported, warning for blocked/planned),
  preset ↔ node-label mismatches (custom topologies warn), schemaVersion
  mismatch, and secret-shaped content anywhere it would persist (reusing
  the injector's redaction patterns). Zod `strict()` schemas reject
  unknown fields, including secret-named keys.
- **Persistence** (`state/store.ts`, migrations 9–10, schemaVersion 8→10):
  `scenarios` table (UNIQUE name, JSON columns for tags/requires/steps/
  execution/validation, recency index); atomic insert/replace (single
  statements; UNIQUE → `SCENARIO_ALREADY_EXISTS`; update with 0 rows →
  `SCENARIO_NOT_FOUND`); restart-reload byte-identical; rows this build
  cannot parse or with a newer schemaVersion are surfaced as structured
  per-row `malformed` entries (`SCENARIO_MALFORMED` /
  `SCENARIO_VERSION_UNSUPPORTED`), never silently dropped or half-parsed.
- **Service** (`scenario/service.ts`): `list` (q/tag/status filters +
  limit/offset paging + total), `get`, `create`, `update` (patch merged
  over the stored record and re-validated WHOLE — a patch cannot smuggle
  an invalid end state; provenance preserved), `remove`, `validate`
  (validate-without-save), `describeOperations` (JSON-safe registry for
  authoring clients). Emits `scenario.created|updated|deleted` audit
  events (actor included). The registry is injected from the live
  injector in `engine.ts` — the service cannot disagree with the injector.
- **API** (`apps/api/src/server.ts`): `GET /api/scenarios` (filters +
  paging), `GET /api/scenarios/operations` (registry),
  `POST /api/scenarios/validate` (200 + validity — a query, not an
  operation), `POST /api/scenarios` (201), `GET/PUT/DELETE
  /api/scenarios/:id`; `SCENARIO_INVALID`→400 (structured issues in
  details), `SCENARIO_NOT_FOUND`→404, `SCENARIO_ALREADY_EXISTS`/
  `SCENARIO_VERSION_UNSUPPORTED`→409; malformed JSON now honors Fastify's
  4xx classification (400 + structured envelope, was 500). There are NO
  execute/run/replay routes (404 by absence, test-asserted). DEC-019
  posture unchanged (loopback-only, JSON-only; scenario endpoints add no
  host-execution power). Typed scenario methods added to the shared web
  client contract (`apps/web/src/api/client.ts` + types) for future CLI/UI
  consumption — no UI was built (T-3.6).

### 2. Gates (commands + actual results, 2026-10-14)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 202/202 passed (21 files) — 136 prior + 66 new:
                         #   scenario.test.ts 32, scenario-store.test.ts 11,
                         #   apps/api/test/scenarios.test.ts 18 (new suite),
                         #   client.test.ts +4, fault.test.ts +1
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 35/35 passed (9 files, 346 s) — full regression;
                         # T-3.2 live fault suites intact
```

No live-node work was needed for T-3.3 (authoring is pure data + SQLite);
the live run is regression evidence only. Hygiene after the run: no
orphaned `portaldot_dev` processes, no leftover netns/iptables rules
(the live suites assert this themselves and passed).

### 3. Files

- New: `packages/engine/src/scenario/{types,operations,validate,service}.ts`;
  `packages/engine/test/{scenario,scenario-store}.test.ts`;
  `apps/api/test/scenarios.test.ts` (+ vitest include);
  `docs/reports/PHASE_03B_REPORT.md` (3B archived verbatim).
- Modified: `fault/{adapter,injector}.ts` + `adapters/{pause,terminate,
  blocked}.ts` (additive: static support + describeMechanisms, single-
  source reason/unblock consts); `state/store.ts` (migrations 9–10 + CRUD);
  `errors.ts` (5 SCENARIO_* codes); `events/bus.ts` (3 scenario events);
  `engine.ts` (scenarios wiring); `index.ts` (exports); `apps/api/src/
  server.ts`; `apps/web/src/api/{client,types}.ts` + client tests;
  `packages/engine/package.json` + lockfile (zod ^4.6.5 — project-standard
  boundary validation, same version as the API, workspace-hoisted);
  `store.test.ts` (schemaVersion 10), `fault.test.ts` (+1 mirror test).

### 4. Problems, decisions, and remaining work

- **Decisions made** (all recorded in DEC-020): registry derives from the
  injector's actual adapters (never a parallel list); blocked/planned ops
  authorable only as warnings; un-evaluable conditions are errors;
  designatedTest enforced at authoring with safe default true; explicit
  step `order` that contradicts position is an error (position is
  authoritative), not silently normalized; validate results carry no
  timestamps (determinism beats convenience). `TARGET_NODE_UNVERIFIABLE`
  (custom presets) is deliberately a warning — labels resolve at run time.
- **zod added to the engine**: justified by the repo-wide Zod-at-boundaries
  rule (AGENTS.md); identical version to apps/api; lockfile updated.
- **Not started (per the phase boundary)**: T-3.4 ScenarioEngine
  execution/recording, T-3.5 replay, T-3.6 CLI/UI surfaces, diagnostics,
  recovery orchestration. RSK-28 records that authoring-time validation is
  inert until T-3.4's executor revalidates through the injector gates.
- Next: **T-3.4** — ScenarioEngine execution with per-action recording and
  cancellation, reusing this model unchanged and executing ONLY through
  the FailureInjector's existing gates (dry-run→execute discipline).

---

## 2026-10-16 — PHASE 3D: Scenario Execution Engine (T-3.4)

**Phase/Task IDs**: Phase 3D — T-3.4 only. Replay (T-3.5), CLI/UI
surfaces (T-3.6), Failure Lab UI, diagnostics (Phase 4), K8s — explicitly
NOT started, roadmap untouched.

### 1. What was built

- **`ScenarioEngine` (`packages/engine/src/scenario/runner.ts`, new)** —
  `engine.scenarioRuns`: `execute()` / `get()` / `list()` / `cancel()` /
  `wait()` / `active()` / `reconcileOnStartup()` / `close()`. Sequential
  execution of a validated scenario snapshot **only** through the
  FailureInjector (preflight → execute; no parallel execution path, no
  weakening of T-3.2 controls). Per-step pipeline: persist `running` →
  bounded cancel-aware delays → preconditions (independent observations,
  honest satisfied/not-satisfied/inconclusive with per-condition budgets)
  → failure policy → injector preflight → `injector.execute` → record
  evidence → postconditions → verification → cleanup → persist. Cancellation
  interrupts only via `injector.cancel` inside a bounded wait; cleanup runs
  on every finish path; unconfirmed cleanup → `cleanup-failed` + high-sev
  event + quarantine (never claimed recovered); step/run deadlines report
  `STEP_TIMEOUT` honestly.
- **`scenario/run-types.ts` (new)** — 13 run states / 11 step states with
  full legal-transition maps + predicates, `ScenarioRunRecord` /
  `ScenarioStepRun` (per-condition verdicts, claims, policy applied,
  warnings, error taxonomy incl. `INTERNAL`), `ScenarioRunReconcileReport`,
  `toRunSummary`. No secrets in records (redaction at persistence).
- **`scenario/conditions.ts` (new)** — run-time condition evaluators:
  rpc-reachable, process-state (alive pid), health-state (monitoring
  snapshot; inconclusive when monitoring is inert — never guessed),
  peers/syncing (inconclusive when RPC down), chain-progress (head increase
  / documented 15 s stall window), recovery-verified (reads the executed
  fault record's own claims); 1 s poll cadence (`SCENARIO_CONDITION_POLL_MS`).
- **Pre-execution gates (fail closed, evaluated before leaving
  `validating`)**: fresh revalidation of the stored definition (RSK-28),
  operation support (blocked/planned refused), exact target resolution,
  designatedTest/chain/preset/minNodes/capability checks, label→managed-
  node resolution for every operation+condition target, quarantine,
  conflict checks (no concurrent run per target/scenario; no active fault
  on a target). A refusal **persists a `rejected` run with its precise
  structured error first**, then throws.
- **Persistence (`state/store.ts`)** — migration 11 (schemaVersion
  **15**): `scenario_runs` + `scenario_run_steps` tables with JSON rows,
  atomic state transitions through the single writer, paginated
  list/filter with per-row `SCENARIO_RUN_MALFORMED` entries; raw
  `updateScenario`/`insertFault` helpers for crafted test/reconcile rows.
- **Crash reconciliation** — `injector.recoverInterrupted()` (new):
  execute-mode stuck faults → SIGCONT sweep where needed → terminalized →
  `reconcile()` only releases on fresh proof; dry-run records untouched.
  `ScenarioEngine.reconcileOnStartup()` (idempotent, non-rejecting)
  terminalizes unfinished runs as `INTERRUPTED` (never resumes them) and
  quarantines unproven cleanup failures. `engine.close()` order: runs
  closed (bounded cancel of in-flight faults) → faults.shutdown() →
  monitoring → store.
- **API (`apps/api/src/server.ts`)** — `POST /api/scenarios/:id/execute`
  (202 + run; body requires literal `mode:"execute"` + explicit target),
  `GET /api/scenarios/runs/:runId`, `GET /api/scenarios/runs`
  (filters + limit/offset/total + malformed), `POST /api/scenarios/runs/
  :runId/cancel`; `statusFor` gained 403/404/409 codes. Web client gained
  typed `executeScenario` / `getScenarioRun` / `listScenarioRuns` /
  `cancelScenarioRun` methods + response types — **no UI built** (T-3.6).
- **Errors/events** — new `SCENARIO_RUN_NOT_FOUND` (404),
  `SCENARIO_RUN_CONFLICT` (409), `SCENARIO_EXEC_NOT_ALLOWED` (403),
  `FAULT_INTERRUPTED`; typed `scenario-run.created|state|step|verification|
  cancelled|cleanup-failed|finished` events mirroring every transition.
- **Run authorization** recorded as **DEC-021**: DEC-019 loopback trust +
  literal mode marker + explicit target + engine-side fail-closed gates;
  authenticated non-loopback identity remains T-7.3 (RSK-26 untouched).

### 2. Gates (commands + actual results, 2026-10-16)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 248/248 passed (23 files) — 202 prior + 46 new:
                         #   packages/engine/test/scenario-run.test.ts 37,
                         #   apps/api/test/scenario-runs.test.ts 9;
                         #   per-layer: engine 185, api 27, web 36
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 43/43 passed (10 files, 317 s) — 35 prior + 8 new
                         # live scenario-run checks; T-3.2 fault suites intact
```

Live evidence (8/8 in `test/integration/scenario-runs.int.test.ts`,
real `portaldot_dev` two-node network, independent test-side observation
for every claim): pause run w/ effect observed while held + independent
recovery (same pid, RPC back, head advanced); two sequential steps with
distinct fault records; precondition abort (zero faults, node untouched);
live skip-step continuing to a real execution; cancellation during the
hold via `injector.cancel` w/ verified rollback; STEP_TIMEOUT with no
fault created; phantom non-designated/mainnet targets refused fail-closed
with persisted rejections; unresolvable label refused. CLI: no new CLI
surface (T-3.6 owns it); no orphaned `portaldot_dev` processes after the
run.

### 3. Files

- New: `packages/engine/src/scenario/{runner,run-types,conditions}.ts`;
  `packages/engine/test/scenario-run.test.ts`;
  `apps/api/test/scenario-runs.test.ts`;
  `test/integration/scenario-runs.int.test.ts`;
  `docs/reports/PHASE_03C_REPORT.md` (3C archived verbatim);
  `docs/PHASE_REPORT.md` overwritten with the 3D report.
- Modified: `fault/injector.ts` (`recoverInterrupted`);
  `state/store.ts` (migration 11 + run CRUD + raw update/insert);
  `scenario/validate.ts` (`scenarioRecordToInput` exported);
  `errors.ts` (4 codes); `events/bus.ts` (7 scenario-run events);
  `engine.ts` (wiring + eager reconcile + close order); `index.ts`
  (exports); `apps/api/src/server.ts` (4 routes + statusFor);
  `apps/web/src/api/{client,types}.ts`; `apps/api/test/scenarios.test.ts`
  (posture updated for T-3.4: no implicit execution, execute demands
  marker+target, refusal persists a rejected run);
  `packages/engine/test/store.test.ts` (schemaVersion 15);
  docs (PLAN/RISKS/ARCHITECTURE/TESTING/DECISIONS/PROGRESS).

### 4. Problems, decisions, remaining work

- **Defect found & fixed in the new executor**: `execute()`'s catch block
  overwrote the gate's structured error (e.g. `UNSUPPORTED_OPERATION`
  with step details) with a generic mapping of the thrown code
  (`GATE_REFUSED`) — fixed to preserve `record.error` set by the gates;
  regression-covered by the gate tests asserting exact codes.
- **Validation facts pinned down by tests** (no spec change): every fault
  step requires BOTH `rpc-reachable{expect:true}` and
  `process-state{expect:['running']}` baselines for its target (error if
  absent), preset membership uses `nameSuffix` labels (two-node =
  alice/bob), scenario names reject parentheses — the T-3.4 tests were
  authored to the real rules rather than relaxing them.
- **Poll semantics**: a conclusively-false precondition keeps polling
  until its authored budget (that is correct — states recover); tests
  therefore author tight condition budgets (e.g. 300–500 ms) instead of
  waiting out the 30 s default.
- **Run record's `faultId` is persisted after the fault finishes**, so
  live tests observe in-flight faults through `injector.activeFaults()`
  (the live truth channel) rather than the record — documented in the
  test comments; no schema change was needed.
- **DEC-021** recorded (see above); no existing decision changed.
- **Not started (per instruction)**: T-3.5 replay, T-3.6 CLI/UI surfaces
  (Failure Lab UI), diagnostics, K8s — the roadmap is unchanged and no
  phase report claims them.
- Next: **STOP after T-3.4** per instruction. When resumed, the next
  roadmap task is T-3.5 (replay), which must reuse
  `engine.scenarioRuns.execute()` and never add a second executor.
