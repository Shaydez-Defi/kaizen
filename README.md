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

**Phase 0 — Foundation & Technical Discovery: COMPLETE** (2026-10-09).
No product features built yet; the ground is now verified and documented.

What is already **verified against the real Portaldot binary** (see
`docs/TECHNICAL_RESEARCH.md` for evidence and reproduction commands):

- `portaldot_dev 2.0.0` runs on this machine; dev networks produce blocks (~6 s).
- **A real 2-validator local network forms, peers, syncs, and finalizes**
  (local chain spec + `--bootnodes` + well-known keys).
- RPC surface works: health, peers (with roles/best blocks), sync state, peer
  identity, headers, runtime version (spec 1002, metadata V13), Prometheus
  metrics, chain-spec export, clean shutdown.

What remains unverified (tracked, with exact experiments planned):
`@polkadot/api` WS compatibility, 4-validator topologies, on-chain
staking/session flows, Docker image build, and Kubernetes/Helm (tooling is
installed; no cluster started yet — planned, not abandoned).

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

> ⚠️ Under active construction — Phase 0 delivered documentation and verified
> research only; there is no runnable `kaizen` command yet. These commands
> become valid at the Phase 1 gate (see `docs/IMPLEMENTATION_PLAN.md`).

```bash
git clone https://github.com/Shaydez-Defi/kaizen
cd kaizen
npm install
npm run build
npm test                 # unit tests
KAIZEN_TEST_LIVE=1 npm run test:integration   # real-node integration tests
```

Planned quickstart (Phase 2 gate):

```bash
kaizen network create --preset two-node --name demo
kaizen network status demo --watch
```

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
