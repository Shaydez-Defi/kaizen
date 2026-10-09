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
