# Decision Records (DEC)

Format: context → decision → alternatives → consequences. Newest entries appended.

---

## DEC-001 — TypeScript monorepo for engine, API, CLI, and UI

- **Date**: 2026-10-09 (Phase 0)
- **Context**: Kaizen needs a shared operations engine consumed by both a CLI
  and a web UI, plus an RPC client for a Substrate-based chain (Portaldot,
  metadata V13, spec 1002 — R-15). Environment has Node 24, Python 3.14,
  Go 1.27; no Rust toolchain.
- **Decision**: One TypeScript codebase on Node.js 24, npm workspaces monorepo:
  `packages/engine`, `packages/cli`, `apps/api`, `apps/web`. RPC via
  `@polkadot/api`; API via Fastify + Zod; storage via SQLite
  (`better-sqlite3`); UI via React + Vite.
- **Alternatives considered**:
  - Python backend + official Python SDK: rejected — documented signing bug of
    `substrate-interface` on Portaldot V13 metadata (pallet-scoped Balance
    type, R-16), and it splits the stack (two languages for engine + UI).
  - Go backend: rejected — no mature Substrate client; hand-rolled SCALE codec
    is unjustified risk.
  - Rust engine: rejected — no toolchain in env; slowest iteration; CLI/UI
    would still need a second language.
- **Consequences**: fastest iteration path; one type system end-to-end; the
  ecosystem quirk risk concentrates on `@polkadot/api` (mitigated by T-1.5
  proving WS + metadata against the real node early).

## DEC-002 — CLI calls the engine in-process; Web goes through the API

- **Date**: 2026-10-09
- **Context**: "Shared engine" requirement (spec FR-2) could be satisfied by
  CLI-over-HTTP or CLI-over-in-process imports.
- **Decision**: CLI imports `packages/engine` services directly; the API is a
  thin transport over the same service objects.
- **Alternatives**: CLI as HTTP client of a running API — rejected: forces a
  daemon for simple CLI use, adds failure modes, no logic-sharing benefit.
- **Consequences**: single-source operation logic preserved; CLI works with no
  server running; API and CLI share types and error shapes by construction.
  Caveat: concurrent CLI + API runs must not corrupt SQLite (mitigate with
  WAL mode + busy timeout, T-1.2).

## DEC-003 — REST commands + WebSocket events (no polling-only, no gRPC)

- **Date**: 2026-10-09
- **Context**: UI needs live monitoring (block height, peers, health,
  scenario progress, incidents).
- **Decision**: HTTP REST for commands/queries, single WS endpoint for the
  engine event bus.
- **Alternatives**: pure polling (janky, wasteful), gRPC (overkill, browser
  friction), SSE (fine, but WS is needed anyway for @polkadot/api patterns).
- **Consequences**: one realtime channel to secure and test; event schema is a
  versioned contract in `packages/engine`.

## DEC-004 — Process orchestration safety model

- **Date**: 2026-10-09
- **Context**: The engine spawns host processes; the frontend must never
  execute arbitrary commands (FR-1).
- **Decision**: spawn only via argv arrays from an internal node-spec builder
  (no shell strings); per-node base-path under `.kaizen/networks/<id>/`;
  centralized port allocator (p2p/http/ws/prometheus per node); SIGTERM →
  grace period → SIGKILL; all stdout/stderr captured to per-node log files.
- **Consequences**: no shell-injection surface; port collisions prevented;
  log evidence available for incidents; requires explicit port-range config
  (default pool documented in README).

## DEC-005 — SQLite for persistent metadata and history

- **Date**: 2026-10-09
- **Context**: Networks, scenario definitions, run history, incidents must
  survive restarts; no external infra allowed.
- **Decision**: SQLite via `better-sqlite3`, WAL mode, single file in
  `.kaizen/kaizen.db`, versioned migrations.
- **Alternatives**: JSON files (no queryability, race-prone), Postgres
  (infra burden).
- **Consequences**: zero-infra persistence; backups are file copies; concurrent
  access limited to same-host (acceptable: localhost-first product).

## DEC-006 — Deployment behind a single adapter interface

- **Date**: 2026-10-09
- **Context**: Local, Docker, and K8s/Helm targets must coexist; K8s is the
  P2 wow-factor but must not block the core.
- **Decision**: `DeploymentAdapter` interface (deploy/status/logs/destroy/
  recover); Local first, Docker second, K8s/Helm third; UI/CLI consume only
  the interface.
- **Consequences**: core features ship without waiting for K8s; K8s risk is
  isolated to one package; a genuine K8s blocker degrades the wow-factor but
  cannot break the P0 core (per spec §6.6).

## DEC-007 — Node binary acquisition: pinned download + TOFU hash manifest

- **Date**: 2026-10-09
- **Context**: Upstream (`portaldotVolunteer/Portaldot-node`) publishes
  tarballs but no checksums or signatures (RSK-07).
- **Decision**: BinaryManager downloads from the official URL on first use,
  computes SHA-256, stores it in a local manifest, and refuses to run a cached
  binary whose hash later changes without explicit user action. Hash surfaced
  in UI/CLI.
- **Alternatives**: vendor binaries in-repo (bloats repo, still unsigned);
  build from source (no Rust toolchain, huge build).
- **Consequences**: reproducible per-machine; supply-chain gap documented
  honestly rather than hidden.

## DEC-008 — Failure operations gated to designated test networks

- **Date**: 2026-10-09
- **Context**: Failure Lab kills/pauses/disconnects nodes; operating against
  the wrong network would be destructive.
- **Decision**: every failure/destructive operation requires the target
  network to be flagged `designatedTest: true` AND to be of chain type
  Local/Development (verified via `system_chainType`). Engine refuses
  otherwise with an explicit error.
- **Consequences**: mainnet-touching features stay impossible by construction
  until an explicit future decision; aligns with spec FR-5 and §9.

## DEC-009 — No fabricated data, ever

- **Date**: 2026-10-09
- **Context**: Hackathon dashboards often mock data; the spec forbids it.
- **Decision**: UI/CLI render only engine-provided real data; features not yet
  implemented are hidden behind explicit "not implemented" states; incident
  analysis is labeled symptom/evidence, never invented root cause.
- **Consequences**: slower to fill the UI, but every demo claim is backed by a
  real operation — this is the product's core credibility.

## DEC-010 — Phased delivery with documented gates and evidence

- **Date**: 2026-10-09
- **Context**: Multi-phase hackathon build with heavy verification burden.
- **Decision**: work strictly per `docs/IMPLEMENTATION_PLAN.md` phases;
  IMPLEMENTED and VERIFIED are distinct; evidence lands in `docs/PROGRESS.md`;
  AGENTS.md binds future sessions to this process.
- **Consequences**: progress is auditable; scope drift is detectable; chat-only
  claims are not acceptable evidence.
