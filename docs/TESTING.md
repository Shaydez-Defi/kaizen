# Testing Strategy & Evidence

## 1. Test Strategy

Kaizen's credibility depends on real operations, so testing is layered with a
hard rule: **the "real" layer always runs against an actual Portaldot binary,
never a mock.** Mocks exist only for pure-logic unit tests.

| Layer | Tool | Scope | Gated by |
|---|---|---|---|
| Unit | vitest | engine pure logic (topology models, port allocator, scenario validation, state machine, safeguards) | nothing — runs everywhere |
| Integration | vitest + real `portaldot_dev` | process manager, RPC client, network service, failure injection, incident detection, adapters | `KAIZEN_TEST_LIVE=1` + binary present in `.kaizen/bin` |
| E2E | scripted CLI/API flows (Playwright later for UI) | full lifecycle CREATE→MONITOR→BREAK→DIAGNOSE→RECOVER→DEPLOY | `KAIZEN_TEST_E2E=1` |
| Contract | supertest (API), JSON-schema of `--json` CLI output | API/CLI surface stability | runs with unit suite |

Conventions:
- Integration tests allocate ports from the engine's allocator (no hardcoded
  9933/9944) and use throwaway base-paths under the OS temp dir.
- Tests must clean up processes; a leaked `portaldot_dev` fails the suite.
- Every test that flips a RESEARCH status to VERIFIED records its evidence in
  `docs/PROGRESS.md` (command + actual result).

## 2. Environment Prerequisites

- Linux/macOS host, x86_64/arm64 (macOS binaries exist upstream; verify).
- Node.js 24+, npm 11+.
- Network access to `github.com/portaldotVolunteer/Portaldot-node` for first
  binary fetch (then offline-capable).
- ~1 GiB free RAM per running node process; ports from the configured pool.
- For P2 tests only: Docker daemon (T-6.1/6.2), minikube + kubectl + Helm 4
  (T-6.3/6.4).

## 3. Tests Executed in Phase 0 (evidence of environment/tech facts)

These are the sanctioned Phase 0 probes (read-only or ephemeral; run on
2026-10-09 in `/tmp/opencode/portaldot-probe`, all processes cleaned up).
Full detail in `docs/TECHNICAL_RESEARCH.md`.

| # | Test | Command essence | Actual result |
|---|------|-----------------|---------------|
| 1 | Artifact fetch | GitHub API listing + 29.6 MB tarball download | 4 tarballs exist; testnet-ubuntu = `portaldot_dev` + `subkey` |
| 2 | Binary version | `./portaldot_dev --version` | `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu` |
| 3 | CLI surface | `./portaldot_dev --help`, `build-spec --help`, `key --help` | full multi-node + key + spec toolset present (R-02) |
| 4 | Single dev node | `--dev --alice` with explicit ports | BABE blocks ~6 s; Prometheus on 9615 (R-03) |
| 5 | HTTP RPC | `system_health/chain/name/version/peers/localPeerId/syncState`, `chain_getHeader`, `state_getRuntimeVersion` | all returned real data; specName `portaldot` specVersion 1002 (R-07) |
| 6 | Chain spec export | `build-spec --chain local --raw --disable-default-bootnode` | 1,488,964-byte raw spec; Local Testnet; genesis includes babe/grandpa/staking/session/imOnline (R-10) |
| 7 | **2-node network** | Alice node + Bob node with `--bootnodes` | peered (`peers:1`, roles AUTHORITY), identical best block #7, finalized #5 on both (R-04) |
| 8 | Metadata version | `state_getMetadata` → magic/version bytes | magic `meta`, **V13** (R-15) |
| 9 | Graceful stop | `kill <pid>` (SIGTERM) on both nodes | clean exit; `pgrep` confirms no orphans (R-09) |
| 10 | Container feasibility | `file`/`ldd` on binary; `docker ps` | glibc dynamic binary (libstdc++/libz only); Docker daemon running (R-17) |
| 11 | K8s tooling | `kubectl cluster-info`, `helm list`, `which minikube` | clients present; no cluster reachable; minikube installed (R-18) |

Negative/edge findings recorded honestly:
- `--tmp` + `--base-path` are mutually exclusive (clap error) — engine must
  never emit both.
- `pkill -f <pattern-that-matches-own-shell>` footgun during probes — noted for
  test-harness design (use exact-name kills).

## 4. Tests Executed in Phase 1 (unit + live suite + CLI smoke)

Run 2026-10-09 on the machine described above. Gates before any commit:
`npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run build`, and
`KAIZEN_TEST_LIVE=1 npm run test:integration` (live suite). The live suites
**skip** (never report passing) without the env var.

### 4.1 Unit suite — `npm test` (no network, no binary, fast)

32 tests / 6 files in `packages/engine/test/` and `packages/cli/test/`:
`buildNodeArgs` + `assertSafeArgs` (forbidden `--tmp`/external-RPC flags),
StateStore (migrations, networks/nodes/operations CRUD, operation→network
linking), PortAllocator (probe-bind, range/stride behavior, exhaustion),
event bus (subscribe/unsubscribe), BinaryManager (TOFU manifest logic with
injected fetch/spawn — no real download), `isPidAlive` guard (pid ≤ 0 never
alive — 0/-1 have process-group kill semantics), log tail, pid file path.

### 4.2 Live suite — `KAIZEN_TEST_LIVE=1 npm run test:integration`

Real `portaldot_dev` processes; isolated temp dirs per suite
(`os.tmpdir()/kaizen-it/…`); ports from the engine allocator; shared binary
cache in `os.tmpdir()/kaizen-test-bin` (downloaded once per machine);
240 s per-test timeouts; `fileParallelism: false` to avoid port/CPU races.

| File | Tests | What it proves against the real binary |
|---|---|---|
| `binary.int.test.ts` | 1 | fresh download → SHA-256 verify → `--version` smoke; re-run idempotent (cached tarball re-verified) |
| `process.int.test.ts` | 4 | start → RPC-healthy → duplicate refused → SIGTERM stop, no orphans; invalid flag → `STARTUP_FAILED` + log tail; **cross-process adopted stop** (second manager instance stops the daemon via persisted pid); **external SIGKILL → `crashed` state + restart recovers chain DB (height not lost)** |
| `rpc.int.test.ts` | 5 | typed snapshot (chain `Development`, spec `portaldot@1002`, real libp2p peer id, finalized head); head subscription delivers advancing blocks; dead port → structured `RPC_CONNECTION_FAILED`; `readSnapshot` one-shot; **node stop+restart → same client reconnects and reads resume** |
| `network.int.test.ts` | 2 | single-node full lifecycle (create→start→real RPC inspect incl. finalized→stop→remove, history recorded, no orphans); **two-node: both `peers≥1` with AUTHORITY roles, cross-checked peer ids, identical best hash, finality progressing equally on both** |
| `api.int.test.ts` | 4 | `/api/health`; Zod validation → structured 400; network create/list delegates to the real engine; WS `/api/events` streams a hello + engine events |

Result: **16/16 live tests pass**; `pgrep -ax portaldot_dev` after the suite
→ no orphans.

### 4.3 CLI smoke (T-1.7, scripted shell)

`setup` (fresh 30 MB download + verify) → `status` → `network create` →
duplicate create → structured `NETWORK_ALREADY_EXISTS`, exit 1 → invalid
name → `--json` INVALID_INPUT envelope, exit 1 → `list` → `start` (health-
gated) → `status` (real RPC height/peers/spec via the API-inspect path) →
`--json status` parsed by a JSON consumer → `stop` (cross-process adopted
stop) → `remove` → `list` empty. **13/13 steps pass.**

### 4.4 Bugs the live suite caught (fixed; regression-tested)

Honesty demands recording these — the live layer earned its keep:

1. `withTimeout()` resolved `void`, so "graceful stop" checks were always
   falsy → every successful stop escalated to SIGKILL *and* reported
   `STOP_TIMEOUT`. Fixed + manager unit tests.
2. `new WsProvider(url, false)` disables auto-connect — `ApiPromise.create`
   hangs forever. Fixed (numeric retry delay).
3. `key generate-node-key` prints the peer id to **STDERR**; the engine
   parsed stdout only → two-node create failed. Fixed (parse both streams;
   never log the key file content).
4. `api.provider` is `undefined` on @polkadot/api v17 — raw
   `system_localPeerId` always failed (surfaced as a `null` peer id with a
   warning). Fixed (client holds the `WsProvider` reference).
5. `isPidAlive(0)` → `kill(2)` pid 0 signals the whole process **group**;
   the pid ≤ 0 guard was missing. Fixed + unit test.
6. `@fastify/websocket` routes registered synchronously on the root instance
   *before* the plugin loads never get the `onRoute` hook → `websocket: true`
   silently ignored (handshake → 500). Fixed (routes in a plugin scope).
7. Cross-process gap: CLI processes are short-lived while nodes are daemons,
   but `stop()` refused nodes it didn't start — and the failed stop nulled
   the pid, letting `remove()` delete a **running** node's data dir. Fixed
   (adopted stop via persisted pid/pidfile; stop failure keeps the record
   intact) + live test.
8. Crash state (`crashed` vs `stopped`) incorrectly depended on an `onExit`
   notification hook being wired. Fixed (crash detection is intrinsic).
9. `network.create` operations weren't linked to the created network id
   (history filter missed them). Fixed (`attachOperationToNetwork`) + test.

### 4.5 Skipped-on-purpose (never reported as passing)

Without `KAIZEN_TEST_LIVE=1` the entire 4.2 table is skipped. `subkey` is
not exercised (bundled binary, no Kaizen feature needs it yet). PromQL
scrapes of Prometheus are not part of the suite (Phase 2 monitoring uses
RPC-first signals).

## 5. Known Limitations (current)

- No image built for Docker (T-6.1), no cluster started (T-6.3).
- Validator staking flows unexercised on-chain (Phase 5).
- Alive-but-stalled node detection (Phase 0 DB-wedge signature) belongs to
  T-2.4 monitoring, not yet built.
- Single-host partition fidelity depends on mechanism chosen (T-3.1, RSK-09).
- Live suite verified on linux-x64 only (macOS/WSL per R-20).

## 6. Reproduction Instructions for Phase 0 Probes

```bash
mkdir -p /tmp/portaldot-probe && cd /tmp/portaldot-probe
curl -sL -o portaldot-testnet-ubuntu.tar.gz \
  https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-ubuntu.tar.gz
tar -xzf portaldot-testnet-ubuntu.tar.gz && cd portaldot-testnet-ubuntu && chmod +x portaldot_dev subkey
./portaldot_dev --version

# single node + RPC probes
mkdir -p /tmp/pd1
./portaldot_dev --dev --alice --base-path /tmp/pd1 --port 30343 \
  --rpc-port 19933 --ws-port 19944 --no-telemetry &
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' http://127.0.0.1:19933

# 2-node local network
./portaldot_dev build-spec --chain local --raw --disable-default-bootnode > local-raw.json
./portaldot_dev --chain local-raw.json --alice --base-path /tmp/pdA --port 30353 \
  --rpc-port 19953 --ws-port 19964 --prometheus-port 9715 --name kaizen-A &
# read peer id from log: "Local node identity is: <PEER>"
./portaldot_dev --chain local-raw.json --bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<PEER> \
  --base-path /tmp/pdB --port 30354 --rpc-port 19954 --ws-port 19965 --prometheus-port 9716 --name kaizen-B &
# then: system_peers / chain_getHeader on both ports; kill both when done
```

## 7. Future Test Requirements (by phase)

- Phase 1: process-manager failure matrix (SIGTERM, SIGKILL, crash-on-start,
  port-in-use, disk-full base-path), RPC reconnect on node restart.
- Phase 2: 4-node topology test, peer-drop detection, monitor state machine.
- Phase 3: each fault mechanism positive+negative test; scenario replay
  determinism check (same action sequence, recorded, not outcome-claimed).
- Phase 4: every signal collector induced-fire test; recovery outcome recorded.
- Phase 5: staking/session happy-path + permission-denied paths.
- Phase 6: image build, container network, helm install/upgrade/destroy on
  minikube, pod-kill recovery.
- Phase 7: full-lifecycle E2E from clean clone; security audit checklist.
