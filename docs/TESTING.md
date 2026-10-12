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

## 5. Tests Executed in Phase 2A (topologies, monitoring, API/WS, CLI)

Run 2026-10-10 on the same host. Gates before commit: `npm run typecheck`,
`npm run lint`, `npm test` (unit), `npm run build`, and
`KAIZEN_TEST_LIVE=1 npm run test:integration`.

### 5.1 Unit suite — `npm test`: 81 tests / 10 files (Phase 1: 32)

New coverage: topology presets + custom validation (duplicate names/keys,
keyless validators, >6 validators, missing validators, invalid input
rejected before side effects); ChainSpecService against a fake binary
(plain → patch → raw pipeline, authority parsing, key-derivation URIs,
genesis audit sidecar, key material never logged); health state machine
(process-death precedence over RPC failures, unavailability threshold,
stall, stale-data, peer grace); HTTP sampler against a live local stub RPC
server (parallel fan-out, per-method degradation to null + warning);
MonitoringService (in-flight overlap guard, `monitor.*` event payloads,
auto-stop on network stop events, `snapshotNow`); NetworkService with the
fake binary (four-validator build, unique ports, bootnode wiring,
partial-create rollback leaves no debris, purge semantics, recovery after
a failed create); store migrations v4/v5 (sticky `started_at`,
`expected_peers`, idempotent `close`).

### 5.2 Live suite — `KAIZEN_TEST_LIVE=1 npm run test:integration`

Real `portaldot_dev` processes; isolated temp dirs; engine-allocated ports;
shared verified binary cache; sequential files. Final run: **25/25 tests /
7 files in 213 s; `pgrep -ax portaldot_dev` → no orphans.**

| File | Tests | What it proves against the real binary |
|---|---|---|
| `topology.int.test.ts` | 6 | 4-validator: patched spec built from the binary, full mesh (peers=3), identical genesis hash on all four, blocks produced, GRANDPA finality; validator+fullnode: keyless node reaches network head, syncs, authors nothing; custom 3-node topology; invalid topology → structured error with zero debris (no dirs, no ports, no DB rows); purge → restart boots from genesis with the same peer ids; concurrent creates → unique identities/ports/specs |
| `monitor.int.test.ts` | 1 | auto-attach on `running`; real samples (heads, peers, genesis hash, uptime, expected peers); connectivity observed over RPC; external SIGKILL → `unhealthy` with crash evidence; survivor observes the 1→0 peer transition; polling stops with the network; on-demand snapshot honest for stopped nodes (`unhealthy`, never "healthy") |
| `api.int.test.ts` | 6 | custom-topology validation → structured 400 with per-problem details; node detail/list semantics; node ops on a non-running node → 409 `NODE_NOT_RUNNING`, unknown node → 404 `NODE_NOT_FOUND`; monitor endpoint honest on a stopped network; purge; WS streams typed `network.created` + `network.status` with timestamps and ids |
| `binary.int`, `process.int`, `rpc.int`, `network.int` (Phase 1) | 12 | Phase 1 coverage re-run green (unchanged) |

### 5.3 CLI smoke (scripted shell over the Phase 2A surface)

**21/21 steps** on a real four-validator network (script under
`/tmp/opencode/cli-smoke.sh`, data dir outside the repo, verified binary
cache reused): `status`; `network create --preset four-validator` (4 nodes
persisted + genesis audit sidecar present); health-gated `start`;
`network monitor` → all 4 reachable with real heads; second snapshot →
**full mesh observed over RPC (peers ≥ 3 on all four)**; `node list` all
running; `node stop`/`node start` on one validator; `purge` correctly
**refuses while nodes run**; `stop`; `purge`; restart → boots from genesis
(best #4 < 30); `remove`; list empty; `pgrep` → no orphans.

### 5.4 Bugs the Phase 2A tests caught (fixed; details in PROGRESS §4)

1. Health precedence: a dead/never-started node was mislabeled
   `unavailable`/`unknown` because RPC-failure counting ran before the
   process-liveness check. Fixed + unit test.
2. Stdio drain race: capturing subprocess output on `'exit'` instead of
   `'close'` occasionally lost the peer-id line under concurrent key
   generation (caught by the live concurrent-create test). Fixed in every
   capture path, with signal-aware error text.
3. Unit-level catches during development: head-advance closure bug,
   promise-result shape misuse, non-idempotent store `close`.

## 6. Known Limitations (current)

- No image built for Docker (T-6.1), no cluster started (T-6.3).
- Validator staking flows unexercised on-chain (Phase 5).
- Stall ("alive but wedged") detection is implemented in the health machine
  (chain-stalled reason, unit-tested) but was not induced against a real
  wedged node — that belongs to Phase 3 failure work.
- The `unavailable` state is unit-tested; the live suite exercises the
  stronger process-dead → `unhealthy` path (by design, process evidence
  takes precedence).
- Partial authority-set finality (e.g. 3-of-4 online) deliberately untested
  (Phase 3; RSK-12).
- Single-host partition fidelity depends on mechanism chosen (T-3.1, RSK-09).
- Live suite verified on linux-x64 only (macOS/WSL per R-20).

## 7. Reproduction Instructions for Phase 0 Probes

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

## 8. Future Test Requirements (by phase)

- Phase 1: process-manager failure matrix (SIGTERM, SIGKILL, crash-on-start,
  port-in-use, disk-full base-path), RPC reconnect on node restart.
- Phase 2B: UI e2e — dashboard renders live WS data from a real network;
  no-mock-data assertion.
- Phase 3: each fault mechanism positive+negative test; scenario replay
  determinism check (same action sequence, recorded, not outcome-claimed);
  induced wedge → stall detection; partial-authority finality characterization.
- Phase 4: every signal collector induced-fire test; recovery outcome recorded.
- Phase 5: staking/session happy-path + permission-denied paths.
- Phase 6: image build, container network, helm install/upgrade/destroy on
  minikube, pod-kill recovery.
- Phase 7: full-lifecycle E2E from clean clone; security audit checklist.

## 9. Tests Executed in Phase 2B (web UI, client layer, logs endpoint)

### 9.1 Component/unit layer (mocked — fixtures only, never production)

`npm test` → **113 tests / 17 files pass** (81 pre-existing engine/CLI
unchanged + 32 new web tests, `apps/web/src/**/*.test.{ts,tsx}`):

- `api/client.test.ts` (7): success envelope; structured error → `ApiError`
  with code/status/issues; non-envelope failure → `HTTP_500`; non-JSON 2xx →
  `BAD_RESPONSE`; hung request → `TIMEOUT`; transport failure →
  `NETWORK_ERROR`; failed `OperationResult` returned as value (never thrown).
- `api/events.test.ts` (6): single socket for many subscribers; event fan-out
  + garbage frames ignored; reconnect with backoff → new socket → `resync`
  fires once; no reconnect with zero listeners; `close()` tears socket+timers;
  exact status transition sequence.
- `pages/OverviewPage.test.tsx` (4): metrics DERIVED from responses (not
  hardcoded); unhealthy counted from real health states; empty state; error +
  retry.
- `pages/NetworksPage.test.tsx` (4): list + client-side filter; create →
  navigate; API validation issues rendered; list failure error state.
- `pages/NetworkDetailPage.test.tsx` (4): nodes + live tables incl. honest
  `unreachable` cells; Start runs + refetches actual state; purge requires
  confirmation (cancel does nothing); not-found error state.
- `pages/NodeDetailPage.test.tsx` (3): live chain data + real log tail;
  explicit `RPC unreachable` state (no invented numbers); unknown-node error.
- `pages/EventsPage.test.tsx` (4): honest waiting state; one row per event
  delivery with real timestamp; reconnect banner + no replayed/fake events;
  kind filter.

jsdom environment; `src/test-utils/` holds the scripted `FakeWebSocket`,
record builders, and render wrapper (test-only).

### 9.2 Live suite — `KAIZEN_TEST_LIVE=1 npm run test:integration`

**30 tests / 8 files** (Phase 2A's 25 + webclient 5). Full-suite runtime
224.79s on this host. One failure during the phase was api.int asserting the
pre-DEC-017 node-route contract (`sample: null`); the contract intentionally
improved (on-demand sample of honest unreachable data) and the test was
updated — re-run green.

New file `test/integration/webclient.int.test.ts` runs the ACTUAL
`KaizenApiClient` + `KaizenEventStream` (the browser's code) against a real
API server + engine + real `portaldot_dev` network (single-node preset,
health-gated start → monitor → stop → remove):

1. health + structured `INVALID_INPUT` errors through the client;
2. create → detail (1 node) → `network.created` observed on the UI stream
   with a real timestamp; structured 404 for unknown ids;
3. start (health-gated) → monitor: `healthy`, peers `0/0`, real head number,
   `0x…` genesis; node detail carries the same live evidence; **cross-check
   vs an independent raw RPC read** (head within drift, peer count equal,
   real `12D3KooW…` peer id);
4. new logs endpoint → real log bytes from disk (`listening for new
   connections…`); invalid `maxBytes` → structured 400;
5. stop → `stopped` + honest `unhealthy`/unreachable; typed
   `network.status running/stopped` events seen on the stream; cleanup.

Reproduce:

```bash
npm run build
KAIZEN_TEST_LIVE=1 TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  npm run test:integration
pgrep -ax portaldot_dev   # must print nothing after the suites
```

### 9.3 Verification boundary (read this before citing evidence)

- **Real backend/infrastructure**: §9.2 only (REST/WS/engine/nodes/RPC +
  the UI's transport code end-to-end).
- **Mocks/fixtures**: everything in §9.1 — rendering and state logic.
- **NOT done**: real-browser E2E (no Playwright in the repo) — RSK-23. Do
  not describe Phase 2B as "browser-verified".
