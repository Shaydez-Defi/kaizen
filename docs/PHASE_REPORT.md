# Phase 2A Report — Topology Engine & Live Monitoring

**Date**: 2026-10-10
**Tasks**: T-2.1, T-2.2, T-2.3, T-2.4, T-2.8, T-2.9 (split from Phase 2;
web UI tasks T-2.5…T-2.7 remain Phase 2B, deliberately **not started**)
**Outcome**: COMPLETE — every Phase 2A task is VERIFIED with recorded
evidence (this report, `docs/PROGRESS.md`, `docs/TESTING.md` §5).

---

## 1. What was delivered

- **Topologies as data + validation**: five presets (single-node, two-node,
  four-validator, validator+full-node, custom). Custom topologies are
  validated by a pure function *before* any directory, port, or process is
  touched: unique names, ≥1 validator, validator key material restricted to
  the well-known dev keys (alice…ferdie), full nodes keyless, ≤8 nodes.
- **Per-network chain specs**: the stock Local Testnet spec seeds only two
  genesis authorities (Alice, Bob). Networks that need more get a patched
  plain spec — authority key material derived from the real binary
  (`key inspect`, sr25519 for babe/imOnline/authDiscovery, ed25519 for
  grandpa; derivation verified by reproducing Alice's/Bob's genesis
  entries) — rebuilt with `build-spec --raw`, plus a
  `chain-spec.genesis.json` audit sidecar naming the baked-in authorities.
  Nothing about chain data is hardcoded (DEC-011).
- **Lifecycle**: ordered start/stop, per-node start/stop, partial-create
  rollback (a failed create leaves no debris), `purge` (refuses while any
  node runs; wipes chain DBs; keeps identity, ports, spec — restart boots
  from genesis with the same peer ids), expected-peer wiring
  (nodeCount − 1).
- **Live monitoring**: per-network polling of real HTTP JSON-RPC
  (system_health, system_peers, system_syncState, chain headers/finalized
  head/genesis) every 2 s with an in-flight overlap guard; a pure health
  state machine (`unknown/healthy/unhealthy/unavailable/stale`) that treats
  process liveness as decisive evidence and never fabricates values; typed
  `monitor.sample/health/peers/error` events; automatic start/stop tied to
  network lifecycle; on-demand snapshots for short-lived CLI runs (DEC-012,
  DEC-015).
- **API/WS extension**: network CRUD + start/stop/purge, node detail +
  node start/stop, monitoring snapshots; WS streams typed events with
  timestamps and ids; Zod validation with structured errors and stable
  codes (400 INVALID_INPUT, 404 NETWORK/NODE_NOT_FOUND, 409
  ALREADY_EXISTS/NODE_NOT_RUNNING). Both API and CLI call the shared engine
  only — no duplicated operation logic (FR-2).
- **CLI extension**: `--preset` (all five), `--nodes` custom spec parser,
  `network purge`, `network monitor`, `node list/get/start/stop`.

## 2. Acceptance criteria — evaluated individually

### 2.1 Phase-plan tasks (`docs/IMPLEMENTATION_PLAN.md`, Phase 2A table)

| Task | Criterion | Verdict | Evidence |
|------|-----------|---------|----------|
| T-2.1 | Authority set documented (R-05 flip) | **MET** | Plain spec = exactly 2 authorities (alice `5GrwvaEF…`, bob `5FHneW46x…`), `validatorCount=2`; key derivations reproduced from genesis entries. RESEARCH R-05 → VERIFIED; PROGRESS §1 |
| T-2.1 | Presets + custom validation pure and unit-tested | **MET** | `topologies.test.ts` covers all presets + every custom rejection rule; unit suite 81/81 |
| T-2.1 | Invalid topologies rejected before any side effect | **MET** | Unit (validation is a pure pre-pass) + live: invalid create → structured error, zero dirs/ports/rows (`topology.int.test.ts`) |
| T-2.2 | 4-authority patched spec generated from the real binary | **MET** | Live 4-validator network on the patched spec: full mesh, identical genesis hash, all four authoring (PROGRESS §1; `topology.int.test.ts`) |
| T-2.2 | Sidecar records baked-in authorities | **MET** | `chain-spec.genesis.json` per network (unit + CLI smoke step 4) |
| T-2.2 | Purge resets chain data but keeps identity | **MET** | Live purge → restart from genesis, same peer ids (`topology.int.test.ts`; CLI smoke steps 15–17) |
| T-2.3 | 4 validators full-mesh, all authoring, finality | **MET** | peers=3 everywhere; alice=36/bob=58/charlie=50/dave=42 authored blocks; finalized 12 vs best 14 (spike + live test) |
| T-2.3 | Full node syncs and authors nothing | **MET** | Keyless 5th node: peers=4, synced to network best (95=95), `isSyncing=false`, 0 blocks authored |
| T-2.3 | Node-level ops work | **MET** | `node stop`/`node start` live in monitor, api, and CLI smoke (steps 10–12) |
| T-2.3 | Stop/start cycles clean | **MET** | purge→restart→purge cycles; `pgrep` no orphans after every suite |
| T-2.4 | Samples at ≥1/2 s cadence | **MET** | `monitor.int.test.ts` (2 s configured, samples observed per tick); cadence unit-tested |
| T-2.4 | Crash → unhealthy with reason | **MET** | Live SIGKILL behind the engine's back → `unhealthy`, reason matches /crashed|not running/ |
| T-2.4 | Unreachable → unavailable | **MET (unit)** | Health-machine unit test (3 consecutive RPC failures on a live process → `unavailable`). Live suite covers the stronger process-dead → `unhealthy` path by design |
| T-2.4 | Loop never overlaps | **MET** | In-flight guard unit test (slow tick skips, not stacks) |
| T-2.4 | Polling stops with the network | **MET** | Live: after stop, job gone, snapshot cleared, on-demand snapshot honest |
| T-2.8 | REST mirrors engine services only | **MET** | `server.ts` delegates every route to engine services; no operation logic at the edge |
| T-2.8 | Structured 400/404/409 for invalid input | **MET** | `api.int.test.ts`: INVALID_INPUT (with per-problem details), NETWORK_NOT_FOUND, NODE_NOT_FOUND, NODE_NOT_RUNNING, NETWORK_ALREADY_EXISTS |
| T-2.8 | WS typed events with timestamps+ids | **MET** | `network.created` + `network.status` live over WS; `monitor.*` typed payloads unit- and live-tested |
| T-2.9 | Suite green; evidence recorded; IMPLEMENTED≠VERIFIED; report | **MET** | 81/81 unit; 25/25 live (213 s); CLI smoke 21/21; this report + PROGRESS/TESTING entries |

### 2.2 Spec functional requirements touched (`docs/PROJECT_SPEC.md` §7)

| FR | Assessment | Evidence |
|----|------------|----------|
| FR-1 backend owns all infrastructure ops | **MET** (engine side; no UI exists yet) | All spawning/signaling inside engine services |
| FR-2 CLI and UI call the same engine | **MET** for CLI/API (UI = Phase 2B) | CLI/API are thin delegates; identical results verified via both surfaces |
| FR-3 typed status, duration, structured errors | **MET** | `OperationResult` everywhere; API error envelope with stable codes; CLI `--json` envelopes |
| FR-4 operations logged with actor/target/timestamps/result | **MET** | Operations table rows linked to networks (incl. failed ops via `failOperation`) |
| FR-5 failure ops gated to test networks | N/A this phase | No failure operations exist yet; gate code untouched |
| FR-6 all displayed data from real RPC/process signals | **MET** | Monitoring reports only sampled values or explicit `null`/state; honesty asserted on stopped/unreachable nodes |
| FR-7 secrets never in logs/API/repo | **MET** | Node keys live only in per-node key files; never in DB/argv/logs; `git diff` secret scan clean |
| FR-8 long ops support timeout + cancellation + cleanup | **MET** | Health-gated starts with timeouts; partial-create rollback; SIGTERM→SIGKILL escalation; killAll cleanup in every test hook |

### 2.3 Global acceptance criteria (`docs/PROJECT_SPEC.md` §8)

- **AC-1** (create/start/stop/inspect a ≥2-node network that peers and
  produces blocks): **MET and exceeded** — four-validator networks peer in
  a full mesh, all four authorities produce blocks, GRANDPA finality
  advances, plus a keyless full node follows the chain.
- **AC-2** (web UI shows live data over WS): **not yet met — UI is Phase
  2B**. The underlying data path (engine → typed WS events → API) is
  verified; the UI itself is honestly labeled NOT STARTED.
- **AC-3/4/5**: unchanged by this phase (scenarios, failure lab, Helm).

## 3. Evidence summary

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` | clean (engine, cli, api) |
| Lint | `npm run lint` | clean |
| Build | `npm run build` | ok |
| Unit | `npm test` | **81/81 pass (10 files)** |
| Live | `KAIZEN_TEST_LIVE=1 npm run test:integration` | **25/25 pass (7 files), 213 s**, no orphan processes |
| CLI smoke | scripted 21-step run (real 4-validator net) | **21/21 steps**, no orphans |
| Spike | manual 4-validator + full-node experiment | full mesh, 4/4 authoring, finality, keyless sync (PROGRESS §1) |
| Secrets | `git diff` scan (mnemonics/keys/64-hex) | no matches; `.kaizen/` gitignored |

Skipped-on-purpose (never reported as passing): live suites without
`KAIZEN_TEST_LIVE=1`; macOS/WSL execution; PromQL scrapes.

## 4. Bugs the tests caught (fixed; PROGRESS §4 has full detail)

1. Health-machine precedence — dead/never-started nodes were mislabeled
   `unavailable`/`unknown`; process evidence now dominates RPC failures.
2. Stdio drain race — capturing subprocess output on `'exit'` rather than
   `'close'` occasionally lost the node-key peer id under concurrent
   creation; fixed in every capture path.
3. Development-time unit catches: head-advance closure bug, promise-result
   shape misuse, non-idempotent store `close`.

## 5. Limitations & honest caveats

- Validator custom topologies are capped at six nodes (alice…ferdie) —
  the only key derivations verifiable from this binary (DEC-014).
- `unavailable` (alive process, dead RPC) is unit-tested but not induced
  live; the live suite exercises process-dead → `unhealthy` instead.
- Stall detection (chain-stalled reason) is implemented and unit-tested
  but not induced against a real wedged node — Phase 3 will do that.
- Partial authority-set finality (e.g. 3-of-4 online) intentionally
  untested (RSK-12).
- Monitoring snapshots are in-memory by design (DEC-012); short-lived CLI
  runs use on-demand sampling, not historical replay.
- Verified on linux-x64 only; live nodes used ~5 concurrent processes on a
  2-vCPU host without thrash (RSK-11 narrowed, not closed).

## 6. Next step

Phase 2B (T-2.5 web scaffold → T-2.6 live dashboard over the typed WS
stream → T-2.7 log tail). This phase stops at the engine/API/CLI boundary
per instruction; no UI work was started.
