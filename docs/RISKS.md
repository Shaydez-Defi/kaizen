# Risk Register

Status values: OPEN · MITIGATED · CLOSED · ACCEPTED.
Updated at every phase gate. Each risk names an owner action (task ID).

---

## Technical

| ID | Risk | Sev | Status | Mitigation / Action |
|----|------|-----|--------|---------------------|
| RSK-01 | Multi-node orchestration fragility (port collisions, start-order races, orphan processes) | H | MITIGATED | DEC-004 port allocator + argv spawns; T-1.4 process manager with timeouts & cleanup; Phase 2A live tests: 4-validator + 5-node networks run ordered start/stop with zero orphans and unique ports (PROGRESS 2026-10-10) |
| RSK-02 | Dev-chain DB wedge ("BABE: Unexpected epoch change", documented by PDK R-16) mid-demo | M | MITIGATED | T-1.4 crash/wedge detection + Phase 2A `purgeChain()` recovery (live-tested: purge wipes chain DBs, restart boots from genesis, identity preserved); runtime stall detection = T-2.4 health machine (live crash test) |
| RSK-03 | Validator/session flows more complex than demo window (era/session timing, staking prerequisites) | M | OPEN | Scope Phase 5 as read-only first (T-5.1/T-5.2); guarded writes only after metadata decode (T-5.4); never fake states (DEC-009) |
| RSK-04 | K8s/Helm blocker (chart/Helm v4 quirks, no cluster, image pull policies) | H | OPEN | Early feasibility spike (see plan note); DEC-006 isolates adapter; fallback = Docker Compose-style deployment with documented evidence |
| RSK-05 | Unsafe RPC exposure (system_peers etc. need unsafe methods; must not leak beyond loopback) | H | OPEN | Generated configs use loopback + `--rpc-methods Auto` only; API binds localhost; security pass T-7.3 |
| RSK-06 | Secret handling (node keys, keystore, passwords in process args/logs) | H | OPEN | Never pass secrets via argv (use `--node-key-file`, `--password-filename`); `.kaizen/` gitignored; logs scrubbed; T-7.3 audit |
| RSK-07 | Supply chain: upstream binaries unsigned/unpinned | M | OPEN | DEC-007 TOFU hash manifest; hash surfaced to user; official URL only |
| RSK-08 | Portaldot repo is an old Substrate fork (clap v2 CLI, V13 metadata, legacy types); docs drift from binary | M | OPEN | All behavior proven against the real binary (docs treated as hints, see RESEARCH); capability matrix re-verified per phase |
| RSK-09 | Single-host partition simulation may be imperfect (no netns/iptables guarantees in sandbox) | M | MITIGATED | T-3.1 evaluated mechanisms empirically (RESEARCH R-22): unprivileged reserved-only + proxied-reserved-nodes cut VERIFIED sustained ≥90 s; privileged ip{,6}tables+cgroup (c-iptables-cgroup) and netns+veth (c-netns) VERIFIED with baseline-verified rollback; plain proxy cut and static port rules proven insufficient (reconverge / escape) — T-3.2 must use only the R-22 rule sets under DEC-018 |
| RSK-10 | `@polkadot/api` compatibility with this legacy node build (WS quirks, type registration) | M | OPEN | T-1.5 proves WS + metadata + type registration early, before UI depends on it |
| RSK-11 | Resource envelope: 2 vCPU / 7.8 GiB shared — 4 nodes + Docker + minikube may thrash | M | MITIGATED (nodes only) | Phase 2A ran 5 concurrent real nodes (4 validators + full node) plus monitoring on this host without thrash; Docker + minikube stacking still measured in Phase 6 |
| RSK-12 | Finality behavior with partial authority sets (2-of-N) could confuse demos | L | OPEN | Full-set finality verified for 2-, 3- and 4-authority nets (Phase 2A); partial-set quorum behavior deliberately untested — Phase 3 failure work will characterize it; dashboard shows best vs finalized distinctly |
| RSK-21 | Patched genesis assumes stable dev-key derivations in the binary (session keys baked at create) | M | MITIGATED | Key material derived from the binary at create time (DEC-011), never hardcoded; TOFU hash (DEC-007) refuses a silently changed binary; `chain-spec.genesis.json` sidecar records exactly which authorities were baked in |
| RSK-22 | Monitoring loop degradation (host event-loop starvation) masking node health | L | MITIGATED | 'stale' state distinguishes old samples from node failure (DEC-012); in-flight guard prevents overlapping polls; unref'd timers; unit-tested state machine |
| RSK-23 | No real-browser E2E: UI rendering verified only by jsdom component tests; regressions in actual layout/interaction could ship unseen | M | OPEN | Phase 2B verified the exact client code paths (fetch/WS) live against real nodes (`webclient.int.test.ts`) + 32 component tests; add a Playwright smoke against a running backend in Phase 7 (clean-clone E2E) — until then no browser-E2E claim is made (see PHASE_REPORT boundary) |
| RSK-24 | Fault injector bypass: nodes reconverge around cuts via mDNS, identify-learned direct addresses, fresh ephemeral source ports, and IPv6/eth0 legs — all observed live in T-3.1 | H | OPEN (design constraints proven) | T-3.2 may use only mechanisms verified in R-22: `--no-mdns`/`--reserved-only` wiring for topology faults; both IP families, no interface scoping, cgroup process scope for kernel cuts; every "partition" claim backed by unaffected-node evidence (peers/head/`ss`), never by target silence. T-3.2: the injector implements only pause/terminate and refuses peer-disconnect/partition with typed blocked results (unblock paths named) — no injector bypass of these constraints is possible |
| RSK-25 | A pause whose SIGCONT cannot be proven (cleanup-failed) leaves a paused node that monitoring cannot reach and the operator must reconcile | M | OPEN | Injector marks cleanup-failed + emits high-severity `fault.cleanup-failed` + quarantines the target until `reconcile()` proves the effect gone; `engine.close()` cancels in-flight faults and SIGCONT-sweeps pause records (tested with a lying observer, T-3.2); residual: silent SIGCONT delivery failure needs operator action |
| RSK-26 | Fault execution over the unauthenticated loopback API (DEC-019: equal-or-lesser power to the existing stop/purge endpoints) | M | OPEN | Dry-run is the default; execute requires an explicit `mode:"execute"` marker and full server-side revalidation (DEC-008 gate, ownership, identity); JSON-only parsing + no CORS blocks browser-page invocation; any future non-loopback binding requires an authorization model first (T-7.3 audit) |
| RSK-27 | Fault audit records accumulate in SQLite (pids, RPC observations, plans) over long-lived data dirs | L | OPEN | Records are typed evidence fields + redaction (unit-tested); list queries are limit-bounded; retention policy to revisit with incident timelines (T-4.x) |
| RSK-28 | Scenario validation is authoring-time only: a saved scenario's guarantees (preconditions, bounds, blocked ops) are inert until an executor enforces them | M | OPEN | Authoring has zero execution affordance (no execute/run/replay routes; CRUD/validate never emit fault events or create fault records — asserted by tests); the operation registry mirrors the injector's adapters so blocked mechanisms can never be shown executable; T-3.4's ScenarioEngine must revalidate every scenario through the injector's own preflight/gates at run time before any run — explicit acceptance gate for that task |

## Security

| ID | Risk | Sev | Status | Mitigation |
|----|------|-----|--------|------------|
| RSK-13 | Web UI as an arbitrary-command surface if engine ever passes user strings to shells | H | OPEN | FR-1/DEC-004: argv-only spawns, allowlisted flags, Zod validation at every boundary; T-7.3 audit |
| RSK-14 | Failure Lab misuse against non-test networks | H | OPEN | DEC-008 gate (designatedTest + chainType check), confirmed in unit tests (T-3.2) |
| RSK-15 | History/evidence stores accumulating sensitive material (keys in logs) | M | OPEN | Log scrubbing at capture; evidence bundles reference paths, not key material; T-4.3 review |

## Delivery

| ID | Risk | Sev | Status | Mitigation |
|----|------|-----|--------|------------|
| RSK-16 | Scope creep from the broad locked scope vs hackathon timeline | H | OPEN | Phase gates G1–G5; one task at a time (AGENTS.md); P0 core demoed before P1/P2 polish |
| RSK-17 | "UI exists but backend faked" credibility trap | H | OPEN | DEC-009; every demo claim traced to recorded operation history |
| RSK-18 | Upstream availability (binaries/repo removed or changed) | L | OPEN | Binaries cached locally on first fetch; hashes recorded; README documents the artifact URLs |

## Integration

| ID | Risk | Sev | Status | Mitigation |
|----|------|-----|--------|------------|
| RSK-19 | Ecosystem prior art (pdk) conflicts/licenses | L | MITIGATED | No code reused; learnings only (R-16); MIT vs our MIT compatible anyway |
| RSK-20 | Helm v4 (installed) vs commonly-documented Helm v3 chart syntax | M | OPEN | T-6.3 validates lint/install on the actual client version; pin chart apiVersion accordingly |
