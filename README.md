# Kaizen

**Monitors tell you a validator is up. Kaizen proves it survives going down.**

Kaizen runs fault drills against Portaldot validators — pause a node, kill
it, bring it back — and turns each drill into a **signed, chain-bound
resilience certificate** that anyone can re-check against the chain, plus a
0–100 **resilience score** per validator. Underneath is a full node-ops
platform: real multi-node `portaldot_dev` networks, live monitoring, a gated
Failure Lab with replayable scenarios, and run anchoring on the **Portaldot
V3 test network** — from a web console and a CLI that share one engine.

## Proof-of-Resilience: the trustless drill model

The goal is a score that does not rest on the operator's word. Three
pillars, each marked by what has actually been verified:

| Pillar | What it means | Status |
|---|---|---|
| **1. A future block hash schedules the drill** | Drill timing and fault choice are derived from the hash of a block that did not exist when the drill was committed (commit-reveal), so a drill cannot be pre-staged or cherry-picked. | **Roadmap** — specified in [docs/RESILIENCE_SCORE.md §7.1](docs/RESILIENCE_SCORE.md); not built. Today drills are operator-triggered. |
| **2. Recovery is proven from what the chain records** | Recovery = GRANDPA finality advancing past where it stalled, read from block hashes any verifier can re-fetch; BABE authorship by the validator's own keys before/after the fault is the next step. Operator-measured timings are weighted least. | **Partly implemented** — finalized/best heads (number + hash) are captured before, during and after the fault and re-checked against the chain by `kaizen verify-certificate`; recovery is only declared when finality advances. **Verified live** on x86_64 CI ([run 40042905143](https://github.com/Shaydez-Defi/kaizen/actions/runs/40042905143)): pause drill on a real two-node `portaldot_dev` network, 11 captured hashes re-fetched → `verified`; network stopped → `unverifiable: network offline` ([evidence](docs/evidence/resilience/)). BABE authorship and evidence-class weighting (self-reports weighted least): **roadmap** (§7.2–7.3) — the v1 score still gives the measured recovery time the largest weight. |
| **3. A signed certificate under an open attestation spec** | SHA-256 fingerprint over canonical JSON of the run record + chain evidence, signed with the operator's sr25519 key; open score formula with worked examples. | **Implemented** — `kaizen certify` / `score` / `verify-certificate`, `/api/resilience/*`, spec in [docs/RESILIENCE_SCORE.md](docs/RESILIENCE_SCORE.md); unit-tested (engine 50, CLI 3, API 4) and exercised live in the same CI run (dev-key certificate). `KaizenResilienceRegistry` contract written and tested in an in-memory EVM — **not deployed** (deployer holds ≈3.15 tPOT; the last deploy cost ≈85 tPOT, RSK-30). |

```
drill (pause / terminate) ──► chain evidence (heads + hashes, before/during/after)
        └──► certificate = sha256(canonical{run, runHash, evidence}) + sr25519 signature
                 └──► verify: recompute + check signature + re-fetch block hashes
                 └──► score: 0–100 per validator (docs/RESILIENCE_SCORE.md)
```

```bash
KAIZEN_RESILIENCE_EVIDENCE=1 kaizen run execute <scenarioId> --network <net>   # capture
kaizen certify <runId> --dev-key        # or KAIZEN_RESILIENCE_SIGNER_SURI / _FILE (key outside the repo)
kaizen score <validator>                # 0–100 from certified runs
kaizen verify-certificate <fingerprint> # verified | mismatch | unverifiable (network offline)
```

`--dev-key` uses the public `//Alice` key and is accepted only for local
designated-test networks; such certificates are labelled "DEV KEY —
integrity only, not identity".

```
CREATE → MONITOR → BREAK → DIAGNOSE → RECOVER → DEPLOY
                                 └──→ CERTIFY → SCORE → ANCHOR ON PORTALDOT V3
```

Nothing in the UI is mocked: every number comes from real RPC, real process
state, recorded history, or the V3 chain. Features that are not built yet are
shown disabled and labelled with their phase — never simulated.

## Current status (2026-10-21, Hacker House Week 2)

| Area | Status |
|---|---|
| Node lifecycle (binary download + SHA-256, spawn/stop/purge, ports, logs) | **Verified** on the real binary (Phase 1) |
| Topologies: single, two-node, four-validator, validator + full node, custom | **Verified** (Phase 2A) |
| Live monitoring (peers, heads, finality, sync, health state machine, WS events) | **Verified** (Phase 2A/2B) |
| Failure Lab engine: `pause` (SIGSTOP/SIGCONT), `terminate` (stop + restore), dry run, test-network gate, audit log | **Verified** live (Phase 3B) |
| Scenarios: authoring, validation, execution with evidence, cancel (cross-process), replay | **Verified** live (Phase 3C–3F) |
| CLI for scenarios/runs | **Verified** live (T-3.6A) |
| **Portaldot V3 connectivity probe** (Substrate WS, EVM RPC, node console) | **Verified** live (T-8.1) |
| **Portaldot V3 run anchoring** (KaizenRunRegistry contract + remark, verify) | **Verified** live on the V3 test network (T-8.2) |
| **Proof-of-Resilience** (chain evidence, signed certificates, verify, score v1, registry contract) | See the pillar table above (Phase 9, T-9.1–T-9.5) |
| Web console (new design): Overview, Networks, node drawer, Failure Lab, Scenarios, Incidents evidence, Deployments, Validators, V3, Settings | **Implemented** — 61 jsdom tests; rendered in headless Chromium over fixture API data (T-3.6C); not yet driven against a live network (RSK-23) |
| `kaizen up` (setup if needed → preset network → health-gated start → endpoints) | **Implemented** — 5 unit tests with a fake engine; live run needs an x86_64 host (T-3.6C) |
| `peer-disconnect` / `partition` faults | Blocked by the engine with typed reasons (R-22) — shown disabled |
| Incident detection & correlation | Phase 4 — not built |
| Validator operations (staking, session keys) | Phase 5 — not built |
| Docker / Kubernetes (Helm) deployment | Phase 6 — not built (planned scope) |

Full detail: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) ·
[docs/PROGRESS.md](docs/PROGRESS.md) · [docs/PHASE_REPORT.md](docs/PHASE_REPORT.md).

## Screenshots

Rendered from the real console code in headless Chromium (1440 px) with the
dev-only harness `apps/web/scripts/screenshots.mjs`, which answers `/api/*`
and the event WebSocket with **fixture data** (a four-validator
`meridian-test` network). They show the UI, not a live network run.

| | |
|---|---|
| ![Landing page hero: "A Portaldot network in one command." with the npx kaizen up pill and terminal card](docs/assets/ui/landing-hero.webp) | ![Overview: Network healthy, four glass validator cards joined by live arcs, recent events, stats strip](docs/assets/ui/overview.webp) |
| ![Failure Lab: Break it on purpose, inject-failure panel and fault type strip with blocked types labelled](docs/assets/ui/lab.webp) | ![Failure active: Validator 03 offline, live log, dashed red links, stats](docs/assets/ui/lab-active.webp) |
| ![Incident #0001: cause → effect timeline, what happened, impact, recovery, node log tail](docs/assets/ui/incident.webp) | ![Deployments: real local processes, and the labelled, empty Kubernetes preview (Phase 6)](docs/assets/ui/deployments.webp) |

Full landing page: [docs/assets/ui/landing-full.webp](docs/assets/ui/landing-full.webp).

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    WEB["Web console<br/>React + framer-motion"]
    CLI["CLI<br/>kaizen"]
  end
  subgraph Backend["Kaizen backend (Node.js)"]
    API["Fastify API<br/>REST + WebSocket events"]
    ENG["Shared engine<br/>packages/engine"]
    NET["NetworkService<br/>topologies + chain specs"]
    PM["NodeProcessManager"]
    MON["Monitor<br/>RPC sampling + health"]
    FI["FailureInjector<br/>pause / terminate"]
    SC["ScenarioEngine<br/>runs + replay"]
    V3A["V3AnchorService<br/>run hash → chain"]
    DB[("SQLite<br/>networks, faults, runs, anchors")]
  end
  subgraph Local["Local infrastructure"]
    NODES["portaldot_dev nodes"]
  end
  subgraph V3["Portaldot V3 test network (chain id 420420777)"]
    WS["Substrate WS"]
    EVM["EVM JSON-RPC"]
    REG["KaizenRunRegistry<br/>(pallet-revive)"]
    NC["Node console"]
  end
  WEB <-->|REST + WS| API
  API --> ENG
  CLI --> ENG
  ENG --- NET & PM & MON & FI & SC & V3A & DB
  PM --> NODES
  MON <-->|JSON-RPC| NODES
  FI --> NODES
  SC --> FI
  SC -->|finished run| V3A
  V3A -->|"revive.call anchor(runHash)"| REG
  V3A -->|"system.remarkWithEvent"| WS
  V3A -.->|"verify: block hash, anchoredAt, eth_getCode"| EVM
  WEB -.->|block links| NC
```

## Portaldot V3 integration

Kaizen treats a finished Failure Lab run as evidence worth proving:

1. **Fingerprint** — `computeRunHash` = SHA-256 of the canonical JSON of the
   persisted run record (steps, observations, cleanup, outcome).
2. **Anchor** — written to the V3 test network either through the
   **KaizenRunRegistry** Solidity contract (`contracts/KaizenRunRegistry.sol`,
   EVM bytecode on pallet-revive: `anchor(bytes32 runHash, string meta)`
   emitting `RunAnchored`) or, when chosen explicitly, via
   `system.remarkWithEvent("kaizen:v1:<runHash>:<runId>")` (DEC-027).
   Writes happen only on an explicit, confirmed request, are signed by an
   operator key read from `KAIZEN_V3_SIGNER_SURI` only, and are dry-run
   first; records are persisted before submission and a submission without
   on-chain evidence is recorded as `failed`, never as anchored (DEC-026).
3. **Verify** — recompute the hash from the stored run and re-read the chain:
   block hash at the recorded height, registry `anchoredAt(runHash)`,
   `eth_getCode` for the registry, or the remark text.

Surfaces: CLI `kaizen v3 probe | status | hash | anchor | anchors | verify`
(plus operator-only `deploy-registry` / `import-deployment`), API
`/api/v3/probe|status|anchors|runs/:runId/hash`, `POST /api/v3/anchors`,
`POST /api/v3/anchors/:id/verify`, and the console's **Portaldot V3** screen.

Endpoints (overridable via `KAIZEN_V3_*`): `wss://test-node-v3.portaldot.dev`,
`https://test-evm-rpc-v3.portaldot.dev`, `https://node-console.portaldot.dev`.

### Testnet evidence

Chain **PortaldotV3 Test**, EVM chain id **420420777**, genesis
`0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`.
Signer (public): `5HSwNUrjU8VqBfdjJdmGdEYig96V1uR6qySiKTZF6eoBd32o`.

| What | Block | Transaction hash | Details |
|---|---|---|---|
| KaizenRunRegistry deployed | [136822](https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x567175bb40b891a5103e00c74b1b15b227a67f3da1aa93ef8264a09f580ecef2) | `0x2fa1c5ae2de79d71ca663d7e7050cc9995e4803b234ade6dd916bc3a8d5eff30` | contract `0x08fdadd1ebe16234c03b723255cc12fd98a5ef07` |
| Contract anchor — run `run-mvim409r-32019a7e` | [136899](https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x2efd3f718fd67b044dd23fc7c2135c4cd69c53f6f5dd99170a9fc5e073eb0c69) | `0xa06abaa085c59486bd2a8d8e4d593b30a9a6e521c7908c6de4b3bdbb70f8c5b7` | `pause-alice-drill`, run hash `0x24c2d025…bf1214`, finalized |
| Contract anchor — run `run-mvim7jct-5df7ea0f` | [136919](https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x4f8d4617013382d0c07acb54c7a25ae10a737ed4077ed3383e14b7526b2f7a56) | `0x8ae9cfc07d559c9dc058472869ae6daa1c364d8965f597704bcc44893abd4df9` | `terminate-bob-drill`, finalized |
| Remark anchor — run `run-mvim409r-32019a7e` | [136940](https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x9a2b7b6d5522e54e0ec44d486f5e8b5d8e1c075797bde732209b2fa4267fa6f3) | `0xa9b15505f07d72738159fb24af61f9959319f7e241125c4b1e82d1c8ab1173ff` | `pause-alice-drill` (same run as 136899), finalized |
| Remark anchor — run `run-mvim9v7m-875cdcaa` | [136947](https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x739af302a1aab00977f1af04c619a8cc5ea97d91e8c36a00c1f0e5699fe9e38a) | `0x84027d2397efce0930e1a5abd49b77a741a8820f4373ebb8dc9c97f7fd774f49` | `pause-alice-drill` (replay), run hash `0x26ebf52f…edd9c`, finalized |

All four anchors were re-verified on chain on 2026-10-21 (`verified`: hash and
block hash match; contract anchors also show registry code present and
`anchoredAt`). The anchored runs were real `pause` / `terminate` Failure Lab
runs on a local two-node `portaldot_dev` network; the exact run records are
in [docs/evidence/runs/](docs/evidence/runs/), the anchor records (including
two honestly recorded failed attempts) in
[docs/evidence/v3-anchors.json](docs/evidence/v3-anchors.json), and a unit
test recomputes every anchored hash from them.

![Portaldot node console, block 136899: the signer's revive.call to KaizenRunRegistry with its revive.ContractEmitted (RunAnchored) event](docs/assets/node-console-block-136899.webp)

Costs observed on the V3 test network: ≈85 tPOT to deploy the registry,
≈4 tPOT storage deposit per contract anchor, ≈0.02 tPOT per remark (RSK-30).

## Quickstart

Prerequisites: Node.js 24+, npm 11+, Linux x86_64 or macOS (upstream ships no
linux-arm64 node binary — RSK-31), ~1 GiB RAM per running node.

```bash
git clone https://github.com/Shaydez-Defi/kaizen
cd kaizen
npm install
npm run build                       # engine → cli → api → web
npx kaizen up                       # setup binary if missing → create "kaizen-local"
                                    # (four-validator) → start, health-gated → print endpoints
```

`kaizen up` only orchestrates existing engine calls; it reuses the network if
it already exists, `--no-setup` refuses to download, `--name`/`--preset`
choose another network, and `--target docker|kubernetes` is refused as
Phase 6 (not built). The step-by-step equivalent is
`kaizen setup` → `kaizen network create … --preset four-validator` →
`kaizen network start …`.

Run the console:

```bash
node apps/api/dist/index.js         # API + WS on http://127.0.0.1:4310
npm run dev -w @kaizen/web          # console on http://127.0.0.1:5173 (proxies /api)
```

Open the console → **Overview** (or **Create network**) → watch the live topology →
**Failure Lab**: pause a node, watch the live fault log and verified recovery
→ **Scenarios**: run or replay a drill → **Portaldot V3**: anchor the finished
run and verify it.

Or from the CLI (same engine):

```bash
K=node packages/cli/dist/index.js
$K network create demo --preset two-node
$K network start demo
$K network monitor demo
$K scenario create my-drill.json        # see docs/evidence/runs/*.json → snapshot for a valid shape
$K run execute <scenarioId> -n demo
$K v3 probe                             # read-only
$K v3 status                            # signer address + balance, registry in effect
KAIZEN_V3_SIGNER_SURI='…' $K v3 anchor <runId> --method remark
$K v3 verify <anchorId>
$K network stop demo
```

Writes to V3 need a funded test account in `KAIZEN_V3_SIGNER_SURI`
(never committed, never passed over HTTP). Runtime state lives in
`./.kaizen/` (gitignored) or `$KAIZEN_DATA_DIR`.

What was verified, where: build/typecheck/lint/unit suite (379 tests) on
2026-10-21; API start + V3 probe/status/verify live on 2026-10-21; node
lifecycle and Failure Lab flows live in earlier phases (commands and results
in [docs/TESTING.md](docs/TESTING.md)).

## Development

```bash
npm test                            # unit + jsdom tests (no network, no binary)
npm run typecheck && npm run lint
KAIZEN_TEST_LIVE=1 npm run test:integration   # real nodes (x86_64 host)
KAIZEN_TEST_V3=1 …                            # live V3 probe
KAIZEN_TEST_V3_WRITE=1 KAIZEN_V3_SIGNER_SURI=… …  # live V3 anchoring (spends tPOT)
```

Gated suites are **skipped** without their flag and never reported as passed.

## Documentation

| Document | Purpose |
|---|---|
| [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) | Locked scope, goals, acceptance criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, V3 anchoring path, security boundaries |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, task IDs, statuses |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Chronological engineering log |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision records (DEC-026/027 V3 anchoring, DEC-028 console) |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy, commands, actual results |
| [docs/RISKS.md](docs/RISKS.md) | Risk register |
| [docs/TECHNICAL_RESEARCH.md](docs/TECHNICAL_RESEARCH.md) | Portaldot capability matrix |
| [docs/PHASE_REPORT.md](docs/PHASE_REPORT.md) · [docs/reports/](docs/reports/) | Phase reports |
| [docs/DEMO.md](docs/DEMO.md) | Demo shot list |
| [AGENTS.md](AGENTS.md) | Build governance for agents |

## License

MIT — see [LICENSE](LICENSE).
