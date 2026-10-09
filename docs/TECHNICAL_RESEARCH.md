# Technical Research — Portaldot Capability Matrix

Every entry records: question → source/experiment → evidence → status →
implications → uncertainties → next verification step.

Status labels (used consistently):
- **VERIFIED**: direct evidence or successful reproducible test.
- **PARTIALLY VERIFIED**: some evidence, important detail unresolved.
- **UNVERIFIED**: plausible but not demonstrated.
- **BLOCKED**: cannot proceed, reason documented.

All local experiments were run on 2026-10-09 in the Phase 0 environment
(x86_64 Linux, 2 vCPU, 7.8 GiB RAM) in `/tmp/opencode/portaldot-probe`
(outside the repo; nothing installed machine-wide). Reproduction commands are
included verbatim.

---

## R-01 — How is Portaldot installed; what artifacts exist?

- **Question**: What do we download, and what binaries does it contain?
- **Source**: GitHub API listing of `portaldotVolunteer/Portaldot-node`;
  official docs "Chain Info".
- **Evidence**: Prebuilt tarballs exist (no source build needed):
  | Artifact | Size (bytes) |
  |---|---|
  | portaldot-testnet-ubuntu.tar.gz | 29,591,898 |
  | portaldot-testnet-macos.tar.gz | 25,005,253 |
  | portaldot-mainnet-ubuntu.tar.gz | 30,180,666 |
  | portaldot-mainnet-macos.tar.gz | 25,671,186 |
  Testnet Ubuntu tarball extracts to: `portaldot_dev` (node) + `subkey` (key tool).
- **Status**: VERIFIED.
- **Implications**: Kaizen can manage node binaries itself (download + cache).
  No Rust toolchain needed (none is installed in this environment anyway).
- **Uncertainties**: Upstream publishes no checksums/signatures (see RSK-07).
- **Next step**: T-1.3 pins SHA-256 at first download (trust-on-first-use) and
  records it in the local manifest.

Reproduce:
```bash
curl -s https://api.github.com/repos/portaldotVolunteer/Portaldot-node/contents/
```

## R-02 — Actual node startup command, flags, configuration surface

- **Question**: What CLI does the real binary expose?
- **Source**: Direct execution of the downloaded binary (`--help`, `--version`).
- **Evidence**: `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu` (clap v2-style CLI).
  Key flags confirmed present: `--dev`, `--chain <spec|dev|local|staging>`,
  `--alice/--bob/--charlie/--dave/--eve/--ferdie/--one/--two` (each = `--name X
  --validator` with that account's session keys inserted into the keystore),
  `--validator`, `--base-path`, `--port` (p2p), `--rpc-port` (HTTP),
  `--ws-port` (WS), `--bootnodes`, `--reserved-nodes`, `--reserved-only`,
  `--node-key`/`--node-key-file`, `--keystore-path`, `--in-peers`/`--out-peers`,
  `--name`, `--no-grandpa`, `--force-authoring`, `--pruning`, `--rpc-methods
  Auto|Safe|Unsafe`, `--rpc-cors`, `--listen-addr`, `--public-addr`,
  `--prometheus-port` (metrics ON by default; `--no-prometheus` disables),
  `--tmp`, `-l/--log` filters, `--password`/`--password-filename`.
  Subcommands: `build-spec`, `purge-chain`, `key {generate, generate-node-key,
  insert, inspect, inspect-node-key}`, `inspect`, `sign`, `verify`, `vanity`,
  `export-blocks`, `import-blocks`, `check-block`, `export-state`, `revert`,
  `benchmark`, `try-runtime`.
- **Status**: VERIFIED (flag surface observed on the real binary).
- **Implications**: Everything Kaizen needs for process orchestration, identity,
  key management, and topology wiring is exposed by the binary itself.
- **Uncertainties**: None on flag existence; semantics of some flags follow
  generic Substrate behavior (acceptable risk — see RSK-08).
- **Next step**: none required.

Reproduce: `./portaldot_dev --help`

## R-03 — Starting a local development network (single node)

- **Question**: Does `portaldot_dev --dev --alice` produce a live chain here?
- **Source**: Direct experiment.
- **Evidence**: Node started, logged BABE consensus session, produced and
  imported blocks at ~6 s cadence (Imported #1, #2, ...). Log facts: peer
  identity `12D3KooW...`, Prometheus at `127.0.0.1:9615`, WS listening on the
  given `--ws-port`, default protocol ID `sup`.
- **Status**: VERIFIED.
- **Implications**: Single-node MONITOR loop is immediately implementable.
- **Uncertainties**: None material.
- **Next step**: none required.

Reproduce:
```bash
./portaldot_dev --dev --alice --base-path <dir> --port 30343 \
  --rpc-port 19933 --ws-port 19944 --no-telemetry --name kaizen-probe-1
```

## R-04 — Multi-node local network (peer discovery + sync)

- **Question**: Can several local nodes be configured to discover and connect?
- **Source**: Direct 2-node experiment with exported local chain spec.
- **Evidence**: `build-spec --chain local --raw --disable-default-bootnode`
  produced a 1,488,964-byte raw spec ("Local Testnet", id `local_testnet`,
  chainType `Local`; genesis runtime includes `babe`, `grandpa`, `staking`,
  `session`, `sudo`, `imOnline`, `balances`, `indices`, `treasury`,
  `authorityDiscovery`, `vesting`, `gilt`, `transactionStorage`). Node A
  (`--alice`) and node B (`--bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<A>`)
  connected within seconds: each reported `peers: 1` with `roles: "AUTHORITY"`,
  imported identical blocks (same best hash at #7), and finality progressed
  (`finalized #5` on both).
  **Re-verified through the Kaizen engine (Phase 1, T-1.6)**:
  `NetworkService.create('two-node')` builds the spec, pre-generates node
  keys (`key generate-node-key --file`), wires the bootnode from the real
  peer id, and starts both nodes; the live test converges on `peers ≥ 1` on
  both nodes, bidirectional peer-id cross-check, identical best hash, and
  equal progressing finalized heights — all read via `@polkadot/api` over WS
  (`test/integration/network.int.test.ts`).
- **Status**: VERIFIED (2-node, explicit bootnode wiring, same host).
- **Implications**: Two-, four-validator and validator+fullnode presets are
  buildable with the same mechanism. Peer state is observable via
  `system_peers` (peerId, bestHash, bestNumber, roles).
- **Uncertainties**: 4-node behavior and genesis authority set size were not
  inspected; custom chain-spec editing is untested.
- **Next step**: T-2.2/T-2.3 verify 4-validator topology and read genesis
  authorities from the spec.

Reproduce: script archived at Phase 0 (`multinode-test.sh`), summarized:
```bash
./portaldot_dev build-spec --chain local --raw --disable-default-bootnode > local-raw.json
./portaldot_dev --chain local-raw.json --alice  --base-path A --port 30353 \
  --rpc-port 19953 --ws-port 19964 --prometheus-port 9715 --name kaizen-A
./portaldot_dev --chain local-raw.json --bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<A_peer> \
  --base-path B --port 30354 --rpc-port 19954 --ws-port 19965 --prometheus-port 9716 --name kaizen-B
```

## R-05 — Topology presets beyond two nodes

- **Question**: Do four-validator and validator+fullnode topologies work?
- **Source**: Inference from R-04 + `--help` (`--charlie`…`--ferdie` shortcuts)
  and the exported spec (Local Testnet authorities).
- **Evidence**: Mechanism proven for 2 nodes; well-known keys for up to 6
  named validators exist. Genesis authority list not yet inspected.
- **Status**: PARTIALLY VERIFIED.
- **Implications**: Presets should be data-driven from the chain spec's
  genesis authority set.
- **Uncertainties**: Whether the Local Testnet spec seeds 2 or 4+ authorities;
  finality quorum behavior with partially-online authority sets.
- **Next step**: T-2.1 inspects genesis authorities; T-2.3 runs a 4-node test.

## R-06 — Ports, RPC endpoints, WebSocket endpoints

- **Question**: Which endpoints exist and how are they addressed?
- **Source**: `--help`, node logs, live RPC calls.
- **Evidence**: Separate `--rpc-port` (HTTP) and `--ws-port` (WS) flags work
  (older-generation Substrate; NOT the merged-port newer style). This node
  generation defaults: HTTP 9933, WS 9944. Log line "Listening for new
  connections on 127.0.0.1:<ws-port>" observed. HTTP JSON-RPC verified live
  (see R-07). Prometheus at 9615 default (`--prometheus-port` overrides).
  **WS proven with a real client (Phase 1, T-1.5)**: `@polkadot/api` 17.0.2
  `WsProvider` connects to `ws://127.0.0.1:<ws-port>` on the real binary;
  typed snapshot reads (`system_*`, `chain_getHeader`, `state_getRuntimeVersion`),
  `chain_subscribeNewHeads` delivering advancing blocks, raw
  `provider.send('system_localPeerId')`, and auto-reconnect after the node is
  stopped and restarted all verified in `test/integration/rpc.int.test.ts`.
- **Status**: VERIFIED (HTTP + WS both exercised by live tests).
- **Implications**: Kaizen must allocate 3+ ports per node (p2p, HTTP, WS) plus
  Prometheus — port management is a core engine responsibility.
- **Uncertainties**: None material for the local-node use case.
- **Next step**: none required (Phase 2 may add WS subscriptions for the
  monitoring sampler).

## R-07 — Which RPC methods are available; what do responses contain?

- **Question**: Can Kaizen read real operational data over RPC?
- **Source**: Live JSON-RPC calls against the running dev node (HTTP).
- **Evidence** (verbatim responses):
  - `system_health` → `{"isSyncing":false,"peers":0,"shouldHavePeers":false}`
  - `system_chain` → `"Development"`; `system_name` → `"Portaldot Node"`;
    `system_version` → `"2.0.0-unknown-x86_64-linux-gnu"`
  - `system_peers` → `[{"bestHash":"0x27a7…","bestNumber":6,"peerId":"12D3KooW…","roles":"AUTHORITY"}]`
  - `system_localPeerId` → `"12D3KooWP4P5VzoAZgyuMEpDetnoWp2nm9cF53uR6goyUDjrR7zm"`
  - `system_syncState` → `{"currentBlock":4,"startingBlock":0}`
  - `chain_getHeader` → full header incl. BABE digest logs
  - `state_getRuntimeVersion` → specName `portaldot`, specVersion `1002`,
    implName `substrate-node`, 13 runtime APIs listed
  Docs also list (not all exercised): `system_addLogFilter`, `system_addReservedPeer`,
  `system_removeReservedPeer`, `system_reservedPeers`, `system_networkState`,
  `system_nodeRoles`, `system_properties`, `system_chainType`, `system_version`,
  plus `chain`, `state`, `payment`, `grandpa`, `syncstate`, `author`, `babe`
  RPC groups. Note: unsafe-flagged methods (e.g. `system_peers`,
  `add/removeReservedPeer`) are enabled locally because `--rpc-methods Auto`
  → Unsafe on loopback.
- **Status**: VERIFIED (exercised subset) / the documented-but-unexercised
  remainder is PARTIALLY VERIFIED at the set level.
- **Implications**: All MONITOR signals required by the spec exist. The
  reserved-peer RPCs are the intended mechanism for peer disconnect experiments
  (Failure Lab) without killing the process.
- **Uncertainties**: Exact `system_peers` fields under load; behavior of
  `system_addReservedPeer` on this build (needs `--reserved-only` contexts).
- **Next step**: T-3.1 exercises reserved-peer manipulation for disconnects.

## R-08 — Node identity, health, sync, peer inspection

- **Question**: Can each be inspected reliably?
- **Source**: Live RPC + logs (R-07, R-04).
- **Evidence**: identity via `system_localPeerId` + log line; health via
  `system_health`; sync via `system_syncState` + header numbers; peers via
  `system_peers` with roles; block height/finalized via `chain_getHeader`
  and Prometheus (`substrate_block_height{status="best"|"finalized"}`).
- **Status**: VERIFIED.
- **Implications**: Incident detection (R-15) has all raw signals available.
- **Next step**: none required.

## R-09 — Health checks, metrics, graceful shutdown

- **Question**: Does the binary support reliable ops hooks?
- **Source**: `--help`, node logs, kill experiment.
- **Evidence**: Prometheus ON by default (`--no-prometheus` to disable);
  live scrape returned `substrate_block_height{status="best"} 4`,
  `substrate_block_height{status="finalized"} 2`. `SIGTERM` (plain `kill`)
  terminated both test nodes; `pgrep` confirmed exit; no orphan processes.
- **Status**: PARTIALLY VERIFIED (metrics + exit verified; "graceful" = clean
  DB flush after SIGTERM not proven — no corruption observed in restarts).
- **Implications**: Prometheus is a good secondary signal source; process
  manager should use SIGTERM → wait → SIGKILL escalation.
- **Uncertainties**: Behavior under SIGKILL (crash recovery on restart).
- **Next step**: T-1.4 tests SIGKILL + restart to confirm DB recovery.

## R-10 — Chain spec creation (`build-spec`)

- **Question**: Can Kaizen generate/modify chain specs for topologies?
- **Source**: Direct execution.
- **Evidence**: `build-spec --chain local --raw --disable-default-bootnode`
  → valid 1.49 MB raw JSON; non-raw mode shows `name: Local Testnet`,
  `id: local_testnet`, `chainType: Local`, one default bootnode
  (`/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWGjDD5sBKxrScFWdGK8Kv72CH1XbxKD6okKVN5y2yZQHo`).
- **Status**: VERIFIED.
- **Implications**: Topology presets = generate spec once per network +
  wire bootnodes per node. Custom presets feasible via spec templating.
- **Uncertainties**: Editing raw genesis storage directly (JSON surgery) is
  untested.
- **Next step**: T-2.2.

## R-11 — Validator operation requirements (keys, funding, privileges)

- **Question**: What does it take to run validator nodes?
- **Source**: `--help` semantics; docs (staking/session extrinsics); R-04 result.
- **Evidence**: `--alice`…`--ferdie`/`--one`/`--two` = `--name X --validator`
  **plus session keys inserted into the keystore** — i.e. on the Local Testnet
  spec, named well-known accounts act as genesis authorities; our 2-node
  Alice+Bob network produced blocks and finalized, proving validator operation
  works without manual staking on that spec. `key insert` exists for injecting
  custom session keys. Staking pallet (`bond`, `validate`, `nominate`, …) and
  Session pallet (`setKeys`, `purgeKeys`) are documented by Portaldot and the
  `staking`/`session` pallets appear in the Local Testnet genesis.
- **Status**: PARTIALLY VERIFIED (genesis-authority validator operation proven;
  joining as a *new* validator via staking+session-key flow untested).
- **Implications**: Validator UI should present real keystore/session state;
  staking-driven validator onboarding is a Phase 5 task with explicit guards.
- **Uncertainties**: Era/session lengths on the Local spec; whether a fresh
  account can become active within a demo timeframe; reward destination effects.
- **Next step**: T-5.1/T-5.2 read `Session`/`staking` storage on a live local
  network and record era/session timing.

## R-12 — Staking extrinsics (Portaldot-specific)

- **Question**: Which staking operations does the runtime expose?
- **Source**: Official docs `module-interface/extrinsics/staking.html`.
- **Evidence**: Full modern-NPoS surface documented: `bond`, `bondExtra`,
  `unbond`, `rebond`, `withdrawUnbonded`, `chill`, `chillOther`, `nominate`,
  `validate`, `setPayee`, `updatePayee`, `payoutStakers(ByPage)`, `kick`,
  `reapStash`, `restoreLedger`, plus root/admin calls (`setValidatorCount`,
  `setInvulnerables`, `setStakingConfigs`, `forceNewEra*`, `manualSlash`…).
- **Status**: PARTIALLY VERIFIED (documented by Portaldot; not exercised
  on-chain in Phase 0).
- **Implications**: Only the signed, user-space subset (bond/validate/nominate/
  chill/setPayee/unbond/withdraw) belongs in Kaizen's validator UI; root calls
  stay out of scope.
- **Next step**: T-5.3 exercises one `bond`+`validate` on a throwaway local
  network and records the events.

## R-13 — Session-key operations

- **Question**: Can Kaizen support session-key ops?
- **Source**: Official docs `extrinsics/session.html`; `key` subcommand help.
- **Evidence**: `session.setKeys(keys, proof)` and `session.purgeKeys()` are
  documented; `portaldot_dev key insert` (keystore injection) exists;
  `key generate-node-key` / `inspect-node-key` exist for libp2p identity.
- **Status**: PARTIALLY VERIFIED.
- **Implications**: A safe, real flow: generate/inspect keys offline → insert
  to keystore → `setKeys` on-chain → verify via Session storage. Requires a
  signing capability (see R-16).
- **Uncertainties**: Exact `SessionKeys` type shape for this runtime (needs
  metadata decode); proof generation mechanics.
- **Next step**: T-5.4 decodes `Session.Keys` from live metadata before any
  implementation.

## R-14 — imOnline events (validator liveness signals)

- **Question**: Can validator health be observed via runtime events?
- **Source**: Official docs `events/imOnline.html`; local spec genesis keys.
- **Evidence**: Events documented: `AllGood()`, `HeartbeatReceived(AuthorityId)`,
  `SomeOffline(Vec<AccountId32>)`. `imOnline` pallet present in Local Testnet
  genesis (R-04 spec dump).
- **Status**: PARTIALLY VERIFIED (documented + pallet present; events not yet
  observed live).
- **Implications**: `SomeOffline` is a first-class incident signal for the
  Failure Lab; subscribing to events over WS is required.
- **Next step**: T-4.1 subscribes to events while killing a validator and
  records whether `SomeOffline` fires within a session boundary.

## R-15 — Runtime identity and metadata

- **Question**: What runtime/SDK compatibility constraints exist?
- **Source**: Live `state_getRuntimeVersion` and `state_getMetadata`.
- **Evidence**: specName `portaldot`, specVersion `1002` (matches PDK's
  "portaldot-1002"), implName `substrate-node`, transactionVersion 2,
  13 runtime APIs. Metadata magic `meta`, **version 13 (V13)**.
- **Status**: VERIFIED.
- **Implications**: V13 metadata + legacy `LookupSource` types (per PDK) mean
  SDK choice matters — `@polkadot/api` is known-good on V13; Python
  `substrate-interface` has a documented signing bug on this chain (R-16).
- **Next step**: none required.

## R-16 — SDK/CLI ecosystem quirks (prior art from `portaldot-dev-kit`)

- **Question**: What traps did the hackathon-winning toolkit hit?
- **Source**: `github.com/PugarHuda/portaldot-dev-kit` README (1st place,
  Mini Hackathon S1 — a *different* project; we only learn from its findings).
- **Evidence**: (a) Python `substrate-interface` mis-signs Assets-pallet calls
  on V13 metadata because `T::Balance` resolves to the global u128 instead of
  the pallet-scoped u64 — TS signing works; (b) Contracts pallet is a legacy
  pre-2021 rent-model build incompatible with modern ink!/cargo-contract;
  (c) dev-chain DB can wedge with "BABE: Unexpected epoch change"; fix =
  `purge-chain --dev -y`; (d) node runs fine with `--ws-external --rpc-cors all`;
  explorer at portalscan.portaldot.io.
- **Status**: PARTIALLY VERIFIED (documented by a third party with working
  tooling; our own probes are consistent: V13, spec 1002, `purge-chain` exists).
- **Implications**: Confirms TS-stack choice (DEC-001); gives us a known
  failure mode (DB wedge) to detect and a known remedy to encode; keeps ink!
  out of scope.
- **Next step**: T-1.4 adds DB-wedge detection (stalled height + BABE log
  pattern) to the process manager.

## R-17 — Containerizing the node

- **Question**: Can the actual binary run in Docker?
- **Source**: `file`/`ldd` on the binary; `docker ps` (daemon check).
- **Evidence**: ELF 64-bit x86-64, dynamically linked against glibc
  (`/lib64/ld-linux-x86-64.so.2`), links only `libstdc++`, `libz`, `libgcc_s`,
  `libpthread`, `libm`, `libdl`, `libc`. Docker daemon is running (empty
  `docker ps` succeeded).
- **Status**: PARTIALLY VERIFIED (strong feasibility; no image built yet).
- **Implications**: A `debian:bookworm-slim` or `ubuntu` base + the binary is
  expected to work; needs an actual build/run smoke test.
- **Next step**: T-6.1 builds the image and runs a `--dev` container with RPC
  smoke test.

## R-18 — Kubernetes + Helm feasibility

- **Question**: Can a multi-node Portaldot network be deployed to K8s/Helm?
- **Source**: `kubectl cluster-info`, `helm list`, `which kind k3d minikube`.
- **Evidence**: Clients installed: kubectl v1.37.0, Helm **v4.3.0**.
  **No cluster is currently reachable** (kubectl → connection refused on
  localhost:8080). `minikube` IS installed (`/usr/local/bin/minikube`);
  Docker daemon available (minikube docker driver path exists).
- **Status**: UNVERIFIED — not blocked: all tooling present, cluster startup
  is a routine step (`minikube start`), but starting persistent infra in
  Phase 0 was out of scope by instruction.
- **Implications**: P2 path is viable on this machine. Resource risk: 2 vCPU /
  7.8 GiB shared with dev workloads (RSK-11). Helm v4 vs v3 chart syntax is
  a compatibility item to check.
- **Next step**: T-6.3 starts minikube, `helm lint`/`helm install` the chart,
  deploys 2–4 nodes, verifies peering inside the cluster.

## R-19 — Mainnet connectivity

- **Question**: Is `wss://mainnet.portaldot.io` usable?
- **Source**: docs Chain Info only.
- **Evidence**: Documented endpoint (ss58 format 42, token POT, 14 decimals).
  Not probed in Phase 0.
- **Status**: UNVERIFIED (deliberately out of Phase 0 scope).
- **Implications**: Kaizen ships with a hard gate: destructive/failure
  operations are refused unless the target network is explicitly designated
  as a test network (FR-5). Mainnet read-only support is a possible later task.
- **Next step**: none scheduled; requires explicit product decision.

## R-20 — macOS/Windows coverage

- **Question**: What platforms can run the node?
- **Source**: docs Chain Info + GitHub API listing.
- **Evidence**: macOS tarballs exist; Windows: "recommended to run in WSL"
  (no native binary).
- **Status**: VERIFIED (artifact availability).
- **Implications**: Kaizen targets Linux/macOS hosts for local operations;
  documented WSL caveat for Windows.

---

## Summary Matrix

| ID | Capability | Status |
|----|------------|--------|
| R-01 | Binary artifacts & install | VERIFIED |
| R-02 | Startup command / flags / subcommands | VERIFIED |
| R-03 | Single-node dev network | VERIFIED |
| R-04 | Multi-node network (2 nodes, bootnodes) | VERIFIED |
| R-05 | 4-validator & custom topologies | PARTIALLY VERIFIED |
| R-06 | Ports / RPC / WS endpoints | VERIFIED (WS via @polkadot/api, Phase 1) |
| R-07 | RPC methods & responses | VERIFIED (core set) |
| R-08 | Identity/health/sync/peer inspection | VERIFIED |
| R-09 | Metrics / graceful shutdown | PARTIALLY VERIFIED |
| R-10 | Chain spec build/export | VERIFIED |
| R-11 | Validator operation (genesis authorities) | PARTIALLY VERIFIED |
| R-12 | Staking extrinsics | PARTIALLY VERIFIED |
| R-13 | Session-key operations | PARTIALLY VERIFIED |
| R-14 | imOnline events | PARTIALLY VERIFIED |
| R-15 | Runtime identity (spec 1002, metadata V13) | VERIFIED |
| R-16 | Ecosystem quirks (prior art) | PARTIALLY VERIFIED |
| R-17 | Docker containerization | PARTIALLY VERIFIED |
| R-18 | Kubernetes + Helm | UNVERIFIED (tooling present) |
| R-19 | Mainnet endpoint | UNVERIFIED (out of scope) |
| R-20 | Platform coverage (macOS/WSL) | VERIFIED |
