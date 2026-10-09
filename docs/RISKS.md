# Risk Register

Status values: OPEN · MITIGATED · CLOSED · ACCEPTED.
Updated at every phase gate. Each risk names an owner action (task ID).

---

## Technical

| ID | Risk | Sev | Status | Mitigation / Action |
|----|------|-----|--------|---------------------|
| RSK-01 | Multi-node orchestration fragility (port collisions, start-order races, orphan processes) | H | OPEN | DEC-004 port allocator + argv spawns; T-1.4 process manager with timeouts & cleanup; integration tests assert no orphans |
| RSK-02 | Dev-chain DB wedge ("BABE: Unexpected epoch change", documented by PDK R-16) mid-demo | M | OPEN | T-1.4 wedge detection (stalled height + log pattern) + `purge-chain` recovery path; scenarios always start from clean base-paths |
| RSK-03 | Validator/session flows more complex than demo window (era/session timing, staking prerequisites) | M | OPEN | Scope Phase 5 as read-only first (T-5.1/T-5.2); guarded writes only after metadata decode (T-5.4); never fake states (DEC-009) |
| RSK-04 | K8s/Helm blocker (chart/Helm v4 quirks, no cluster, image pull policies) | H | OPEN | Early feasibility spike (see plan note); DEC-006 isolates adapter; fallback = Docker Compose-style deployment with documented evidence |
| RSK-05 | Unsafe RPC exposure (system_peers etc. need unsafe methods; must not leak beyond loopback) | H | OPEN | Generated configs use loopback + `--rpc-methods Auto` only; API binds localhost; security pass T-7.3 |
| RSK-06 | Secret handling (node keys, keystore, passwords in process args/logs) | H | OPEN | Never pass secrets via argv (use `--node-key-file`, `--password-filename`); `.kaizen/` gitignored; logs scrubbed; T-7.3 audit |
| RSK-07 | Supply chain: upstream binaries unsigned/unpinned | M | OPEN | DEC-007 TOFU hash manifest; hash surfaced to user; official URL only |
| RSK-08 | Portaldot repo is an old Substrate fork (clap v2 CLI, V13 metadata, legacy types); docs drift from binary | M | OPEN | All behavior proven against the real binary (docs treated as hints, see RESEARCH); capability matrix re-verified per phase |
| RSK-09 | Single-host partition simulation may be imperfect (no netns/iptables guarantees in sandbox) | M | OPEN | T-3.1 evaluates mechanisms empirically; documented limitation if only process-level isolation is possible |
| RSK-10 | `@polkadot/api` compatibility with this legacy node build (WS quirks, type registration) | M | OPEN | T-1.5 proves WS + metadata + type registration early, before UI depends on it |
| RSK-11 | Resource envelope: 2 vCPU / 7.8 GiB shared — 4 nodes + Docker + minikube may thrash | M | OPEN | Resource budget documented; minikube spike measures real usage; topology presets include small (2-node) variant for constrained hosts |
| RSK-12 | Finality behavior with partial authority sets (2-of-N) could confuse demos | L | OPEN | Phase 0 observed finality progressing with 2 nodes on Local Testnet (R-04); T-2.1 confirms genesis authority count; dashboard shows best vs finalized distinctly |

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
