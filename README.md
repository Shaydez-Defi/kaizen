# Kaizen

**Node operations & infrastructure management platform for the Portaldot
blockchain** — create, monitor, deliberately break, diagnose, recover, and
deploy Portaldot networks through a web interface and a CLI that drive *real*
infrastructure operations.

```
CREATE → MONITOR → BREAK → DIAGNOSE → RECOVER → DEPLOY
```

## Why

Portaldot (a Substrate-based Layer-0 chain) gives you a node binary and a bag
of CLI flags. Running a multi-node network means hand-writing chain specs,
port maps, bootnode wiring, and watching logs — and when something breaks,
figuring out *what* happened is guesswork. Kaizen turns that into one
observable workflow: real node lifecycle management, controlled failure
experiments with history, incident timelines with evidence, and deployment to
Docker and Kubernetes/Helm.

The web UI and the CLI share one operations engine. Nothing in the UI is
mocked: every number comes from real RPC, real process state, or recorded
history.

## Current Implementation Status

**Phase 1 — Foundation & Node Lifecycle Core: COMPLETE** (2026-10-09).
The monorepo is runnable: the shared engine manages **real Portaldot node
processes**, and the CLI and API both drive those same engine services.

What is verified against the real `portaldot_dev` binary (evidence in
`docs/PROGRESS.md`, reproduction commands in `docs/TESTING.md`):

- `kaizen setup` downloads the official artifact, verifies it (SHA-256 TOFU
  manifest), and smoke-checks `--version`; re-runs are idempotent.
- The engine starts/stops/restarts real nodes: argv-array spawn, per-node data
  dirs and ports, log capture, SIGTERM→SIGKILL stop, duplicate/stale-process
  protection, startup-failure detection — no orphan processes left behind.
- The RPC client (`@polkadot/api` over WebSocket) reads real data: chain,
  health, peers (with roles), sync state, block headers, runtime version
  (`portaldot` spec 1002), and delivers live head subscriptions.
- `NetworkService` creates, starts, health-gates, inspects, stops, and removes
  real networks — including a **two-node network where both nodes peer
  (`peers: 1` each, `AUTHORITY` roles) and converge on the same best block**.
- The CLI (`kaizen network …`) and the Fastify API (REST + WS event stream)
  invoke only shared engine services; inputs are validated and errors are
  structured.

What remains for later phases: monitoring/incident detection, Failure Lab,
validator transactions, Docker/K8s deployment adapters, and the real web UI
(Phase 1 ships only a scaffold page).

## Verified Prerequisites (host)

- Linux or macOS (x86_64; Windows: node must run in WSL — upstream ships no
  Windows binary)
- Node.js 24+, npm 11+
- ~1 GiB RAM per running Portaldot node process
- For later phases: Docker daemon; minikube + kubectl + Helm (for K8s)

The Portaldot node binary is fetched automatically on first use from the
official artifact repo and its SHA-256 is recorded locally (no upstream
checksums are published — see RSK-07).

## Installation & Development

```bash
git clone https://github.com/Shaydez-Defi/kaizen
cd kaizen
npm install
npm run build               # engine → cli → api → web
npm test                    # fast unit tests (no network, no binary)
```

Real-node integration tests (downloads the ~30 MB node binary on first run
into a temp cache, spawns real nodes, cleans up):

```bash
KAIZEN_TEST_LIVE=1 npm run test:integration
```

Without `KAIZEN_TEST_LIVE=1` the live suites are **skipped** (never reported
as passing). `npm run lint` and `npm run typecheck` complete the gates.

## CLI Quickstart (Phase 1 surface)

The CLI runs the engine in-process; the API exposes the same services over
REST/WS (`npm run build && node apps/api/dist/index.js` → `http://127.0.0.1:4310`).

```bash
node packages/cli/dist/index.js setup        # explicit binary download + verify
node packages/cli/dist/index.js status       # binary availability (never downloads)
node packages/cli/dist/index.js network create demo --preset single-node
node packages/cli/dist/index.js network start demo
node packages/cli/dist/index.js network status demo        # real RPC: height, peers, spec
node packages/cli/dist/index.js --json network list        # machine-readable everywhere
node packages/cli/dist/index.js network stop demo
node packages/cli/dist/index.js network remove demo
```

Runtime state (SQLite db, node data dirs, logs, binary cache) lives in
`./.kaizen/` (gitignored) or `$KAIZEN_DATA_DIR`.

## Documentation

| Document | Purpose |
|---|---|
| [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md) | Locked scope, goals, functional requirements, acceptance criteria |
| [docs/TECHNICAL_RESEARCH.md](docs/TECHNICAL_RESEARCH.md) | Portaldot capability matrix with VERIFIED/PARTIALLY/UNVERIFIED/BLOCKED statuses |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, communication, security boundaries, stack |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phases, task IDs, acceptance criteria, statuses |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Chronological engineering log (start here for "what happened") |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture/implementation decision records |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy, executed tests, evidence, reproduction |
| [docs/RISKS.md](docs/RISKS.md) | Risk register with mitigations |
| [AGENTS.md](AGENTS.md) | Durable build-governance instructions for agents |

## License

MIT — see [LICENSE](LICENSE).
