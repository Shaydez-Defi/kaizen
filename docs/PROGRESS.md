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
