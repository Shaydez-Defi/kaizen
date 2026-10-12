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

## DEC-011 — Genesis authority patching derives keys from the binary (no hardcoded chain data)

- **Date**: 2026-10-10 (Phase 2A, T-2.1/T-2.2)
- **Context**: The embedded Local Testnet spec seeds exactly TWO genesis
  authorities (Alice, Bob; `staking.validatorCount=2`, verified live — R-05).
  Launching four validator processes does NOT make a four-validator network:
  Charlie/Dave would never author or vote. A genuine N-validator network
  requires editing the plain spec (session.keys, staking.stakers,
  staking.invulnerables, validatorCount) and rebuilding the raw spec.
- **Decision**: ChainSpecService generates every network's spec at create time.
  Authority key material is derived from the real binary at creation time
  (`key inspect //X` for the sr25519 account, `key inspect --scheme ed25519 //X`
  for the grandpa key — the derivation was verified by reproducing the genesis
  entries of Alice and Bob). The patched plain spec is written to the network
  dir, converted with `build-spec --chain <file> --raw --disable-default-bootnode`,
  and a `chain-spec.genesis.json` audit sidecar records which authorities were
  baked in. The two-node preset keeps the UNMODIFIED spec (proven in Phase 1).
- **Alternatives**: hardcoded Charlie/Dave keys in source — rejected (fabricated
  chain data, breaks if the binary's dev keys ever change); running non-authority
  "validators" — rejected (four processes ≠ four authorities; would be dishonest
  labeling); per-network ad-hoc keystore injection — rejected (spec surgery is
  the chain-correct mechanism and was proven live).
- **Consequences**: networks are self-contained artifacts (spec + sidecar in the
  network dir); creation costs a few extra binary invocations; validator
  custom topologies are capped at six (alice…ferdie) — the only keys with
  verifiable derivations from this binary.

## DEC-012 — Monitoring = periodic HTTP JSON-RPC sampling + a pure health state machine

- **Date**: 2026-10-10 (Phase 2A, T-2.4)
- **Context**: Live monitoring must distinguish unhealthy / unknown /
  unavailable / stale, never fabricate values, and never overlap polls. The
  node serves HTTP JSON-RPC and its legacy WS surface; @polkadot/api adds heavy
  subscriptions per sample.
- **Decision**: MonitoringService polls each node every 2s with lightweight
  parallel HTTP POSTs (system_health, chain_getHeader, system_peers,
  system_syncState, chain_getFinalizedHead, genesis hash cached per node). A
  pure `evaluateNodeHealth()` function maps (sample, process liveness,
  previous state) → one of `unknown | healthy | unhealthy | unavailable |
  stale` with evidence-based reasons: process dead/crashed, RPC failures ≥3,
  chain stalled (head frozen while RPC answers), peer shortfall past a 60s
  startup grace, stale sample gaps. One job per network with an in-flight
  guard (a slow tick skips rather than overlaps); jobs stop automatically on
  network stopping/stopped/error events and unref'd timers never hold the
  process open.
- **Alternatives**: WS subscription per sample — rejected for polling (heavier,
  reconnect storms corrupt state machines); DB-persisted samples — rejected
  (write amplification for observational data); trusting `process status`
  alone as health — rejected by design (a running process is not evidence of a
  functioning node, Phase 0 DB-wedge lesson).
- **Consequences**: monitoring data is in-memory (latest snapshot per network
  retrievable via API/CLI while the engine runs); the health machine is fully
  unit-testable without nodes; per-method RPC failures degrade one sample's
  field to null + warning instead of failing the node's health instantly.

## DEC-013 — Node identity, uptime, and peer expectations are persisted; chain data stays disposable

- **Date**: 2026-10-10 (Phase 2A, T-2.3/T-2.4)
- **Context**: Monitoring needs uptime and expected peer counts; purge must
  reset chains without destroying the network definition; node-level
  start/stop must work across short-lived CLI runs (adopted processes).
- **Decision**: schema migration adds `nodes.started_at` (sticky: set on
  start, preserved across later status updates) and `nodes.expected_peers`
  (full-mesh expectation = nodeCount − 1, computed from the topology at
  create). `purgeChain()` refuses while any node process is alive, then
  deletes each node's base dir (chain DB, keystore, peers cache) while keeping
  node keys, ports, chain spec, and records — the next start boots from
  genesis with the same peer ids. Node records that are crashed/stale are
  reset to `stopped` during purge.
- **Alternatives**: store health/samples in SQLite — see DEC-012; recreate the
  network on purge — rejected (destroys audited spec + identity history).
- **Consequences**: restart-after-purge is deterministic and cheap; a network's
  lifecycle (define → start → stop → purge → start) is fully repeatable from
  CLI/API; uptime math survives CLI restarts because started_at lives in the
  store, not in process memory.

## DEC-014 — Validator custom topologies require well-known keys; full nodes take none

- **Date**: 2026-10-10 (Phase 2A, T-2.1)
- **Context**: Custom topologies must be validated before anything is
  created; arbitrary key material cannot be invented (DEC-011).
- **Decision**: a custom topology is an ordered node list; every `validator`
  node must carry a unique well-known key from {alice…ferdie} (those become
  genesis authorities via the patched spec), every `full` node must carry
  none, at least one validator is required, and node names must be unique and
  well-formed. Validation is a pure function (`resolveTopology`) that runs
  before any directory, port, or process is touched; failures carry
  per-problem details. The first node in the list is the bootnode seed.
- **Alternatives**: generate fresh keypairs per validator — rejected (would
  require the binary to insert session keys pre-genesis; not verifiable here);
  allow validators without keys — rejected (a keyless "validator" cannot be a
  genesis authority and would be a misleading label).
- **Consequences**: topology validation is unit-testable in isolation; the
  6-validator ceiling is explicit and produces an actionable error instead of
  a broken network.

## DEC-015 — Monitoring auto-lifecycle is event-driven; CLI/API can also sample on demand

- **Date**: 2026-10-10 (Phase 2A, T-2.4/T-2.8)
- **Context**: Polling must start when a network runs and stop when it stops,
  without every caller wiring it manually; short-lived CLI runs must still be
  able to show a real snapshot.
- **Decision**: MonitoringService subscribes to `network.status` events:
  `running` → start polling that network; `stopping`/`stopped`/`error` → stop
  and drop transient state. `snapshotNow()` performs a one-shot sample +
  health evaluation on demand (used by `kaizen network monitor` and the API
  `GET /api/networks/:id/monitor` when no job is live). WS clients receive
  typed `monitor.sample` / `monitor.health` / `monitor.peers` / `monitor.error`
  events with timestamps and node ids; REST exposes the latest or on-demand
  snapshot. Both surfaces only ever show engine-produced data (DEC-009).
- **Alternatives**: manual start/stop only — rejected (UI would have to wire
  it and the CLI could never observe); persistent daemon requirement —
  rejected (breaks DEC-002's CLI-without-daemon model).
- **Consequences**: any surface that can start a network automatically gets
  monitoring; the event stream is the single source of realtime truth for the
  future web UI (Phase 2B).

## DEC-016 — Web UI is a thin typed client over the existing API; one shared WebSocket; engine types are import-type-only

- **Date**: 2026-10-10 (Phase 2B, T-2.5/T-2.6/T-2.7)
- **Context**: The operations console had to render only real backend data
  without growing a second business-logic layer, duplicating engine models, or
  leaking sockets/timers on navigation.
- **Decision**:
  - A single typed API client (`apps/web/src/api/client.ts`) owns base-URL
    handling, JSON envelopes, structured `ApiError` translation, timeouts, and
    abortability; components never call `fetch()` directly. Lifecycle ops use
    long timeouts (start 300s / stop 120s) because they are health-gated.
  - The UI's model types are `import type`-only from `@kaizen/engine` — zero
    runtime coupling, zero drift from the shared models. The web bundle never
    executes engine code.
  - ONE `KaizenEventStream` for the whole app (React context): auto-reconnect
    with capped backoff + jitter, last-unsubscribe teardown, and a `resync`
    callback after every reconnect — the server does not replay missed events,
    so pages refetch REST state instead of pretending the gap never happened.
  - Live tables poll REST at a bounded cadence (5s while running; paused when
    not running or nothing to show) and refetch on WS-driven invalidation.
    Live data is never optimistic: values come from engine reads only.
  - Node log tail is a real read of the node's captured log file via the API
    (`nodeLogTail` in the shared engine); the pane auto-refreshes (10s) while
    the node runs. No shell access from the browser (FR-1).
- **Alternatives**: per-page fetch calls — rejected (scattered error/timeout
  handling, drift); Redux-style global store — rejected (overkill for five
  screens; the event ring buffer + page-local async state suffice); true WS
  log streaming — deferred (bounded refresh covers the P1 need without a
  second protocol; revisit with since-timestamp tailing if demanded).
- **Consequences**: every UI number is traceable to an API response; the same
  client layer is testable in Node against the real backend
  (`test/integration/webclient.int.test.ts`), which is how the UI's data path
  was verified against real Portaldot nodes in this phase.

## DEC-017 — Node detail route samples on demand when no monitoring snapshot is stored yet

- **Date**: 2026-10-10 (Phase 2B bug found by the live web-client test)
- **Context**: `GET /api/networks/:id/nodes/:nodeId` returned
  `sample: null, health: null` in the window between a network start and the
  monitoring loop's first stored snapshot, even though the node was verifiably
  running — the UI would show "no sample yet" against real evidence.
- **Decision**: the node route now mirrors the monitor route's fallback:
  `getLatest(networkId) ?? snapshotNow(networkId)`. An on-demand sample costs
  one bounded RPC read and reports honest unreachable data when the node is
  down (process evidence stays decisive per the Phase 2A health machine).
- **Alternatives**: leave it and let the UI poll — rejected (first paint after
  start would lie by omission; the fallback already existed one route above).
- **Consequences**: node detail is correct at any moment; caught live by
  `webclient.int.test.ts` (would have been invisible to mocked tests).

## DEC-018 — Kernel-level fault operations are operator-authorized, narrowly scoped, and rollback-verified

- **Date**: 2026-10-12 (Phase 3A, T-3.1 — informed by experiments C3–C5)
- **Context**: Proving sustained network partition on a single host required
  elevated mechanisms (iptables/ip6tables, network namespaces). Static
  port-scoped rules were shown to leak (fresh ephemeral source ports, IPv6
  loopback, eth0 legs), and one harness iteration silently failed to delete
  its rules — i.e. the dangerous part of privileged fault injection is not
  the cut, it is the residue.
- **Decision**: any future Kaizen operation that touches kernel state
  (firewall rules, netns, cgroups) must: (1) obtain explicit operator
  authorization before the run; (2) target only a designated test network
  (DEC-008 `designatedTest` pre-check, unchanged); (3) be scoped to a single
  process or link (cgroup/port rules on both IP families with no interface
  scoping, or a dedicated per-node link) — never host-global firewall
  changes and never FORWARD/DOCKER chains; (4) capture the rule/netns
  baseline before and verify byte-identical restoration after, with rollback
  registered on every exit path (including crashes); (5) record the exact
  commands and evidence in the run log.
- **Alternatives**: unprivileged-only injector (reserved-only + proxy
  rewiring, SIGSTOP) — retained as the default for T-3.2; kernel-level
  mechanisms remain the authorized fallback for cutting arbitrary nodes.
  Host-global firewall edits — rejected outright (would affect unrelated
  traffic, violates the experiment charter).
- **Consequences**: FailureInjector kernel faults are explicit, reversible,
  and auditable; evidence of isolation always includes unaffected-node
  checks (peers/head on non-targets) so a "partition" claim is never made
  from the target's silence alone.
