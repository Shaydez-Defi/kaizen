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
