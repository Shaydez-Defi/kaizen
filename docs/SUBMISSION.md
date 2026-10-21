# DoraHacks — Portaldot Hacker House, Week 2 submission (ready to paste)

## Project name

Kaizen

## One-liner

Break Portaldot networks on purpose — and prove every experiment on the
Portaldot V3 testnet.

## GitHub

https://github.com/Shaydez-Defi/kaizen (Week 2 work: branch `submission/week2`, PR #1)

## Demo video

`<DEMO VIDEO LINK — to be added>` (shot list: `docs/DEMO.md`)

## Project progress (Week 2)

- **On-chain run anchoring on Portaldot V3 (live).** Every finished Failure
  Lab run is fingerprinted (SHA-256 of its canonical run record) and anchored
  on the V3 test network — through our **KaizenRunRegistry** Solidity
  contract running as EVM bytecode on pallet-revive, or via
  `system.remarkWithEvent`. Deployed the registry and anchored real runs with
  both methods; all anchors re-verified on chain (block hash, registry
  `anchoredAt`, `eth_getCode`). Writes are explicit, dry-run first, signed
  from an env-only operator key, and failed attempts are recorded as failed —
  never as anchored.
- **V3 connectivity probe** across Substrate WS, EVM JSON-RPC (chain id
  420420777 checked) and the node console, with per-endpoint typed results.
- **Failure Lab from the CLI**: scenario authoring/validation, execution with
  evidence, cross-process cancel, replay with provenance (`kaizen scenario …`,
  `kaizen run …`), all live-tested against real `portaldot_dev` nodes.
- **New web console** (framer-motion design) wired to the real API: live
  topology, node drawer with logs and diagnostics, Failure Lab (pause /
  terminate with dry run, live fault log, roll back), Scenarios (run, cancel,
  replay), fault evidence, and a Portaldot V3 screen (probe, anchors with
  node-console links, Verify, Anchor run). Unbuilt features are shown
  disabled with their phase label — nothing is simulated.
- Quality: 379 unit/jsdom tests green; typecheck, lint, build green; every
  decision/risk documented (DEC-026/027/028, RSK-30/31).

## Testnet evidence (PortaldotV3 Test, EVM chain id 420420777)

Genesis `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`
· signer `5HSwNUrjU8VqBfdjJdmGdEYig96V1uR6qySiKTZF6eoBd32o`

| What | Block | Tx hash |
|---|---|---|
| KaizenRunRegistry deployed at `0x08fdadd1ebe16234c03b723255cc12fd98a5ef07` | 136822 | `0x2fa1c5ae2de79d71ca663d7e7050cc9995e4803b234ade6dd916bc3a8d5eff30` |
| Contract anchor (pause-alice-drill) | 136899 | `0xa06abaa085c59486bd2a8d8e4d593b30a9a6e521c7908c6de4b3bdbb70f8c5b7` |
| Contract anchor (terminate-bob-drill) | 136919 | `0x8ae9cfc07d559c9dc058472869ae6daa1c364d8965f597704bcc44893abd4df9` |
| Remark anchor (pause-alice-drill) | 136940 | `0xa9b15505f07d72738159fb24af61f9959319f7e241125c4b1e82d1c8ab1173ff` |
| Remark anchor (pause-alice-drill replay) | 136947 | `0x84027d2397efce0930e1a5abd49b77a741a8820f4373ebb8dc9c97f7fd774f49` |

Node console (block 136899):
https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0x2efd3f718fd67b044dd23fc7c2135c4cd69c53f6f5dd99170a9fc5e073eb0c69

Evidence files in the repo: `docs/evidence/v3-anchors.json`,
`docs/evidence/runs/*.json`, `docs/assets/node-console-block-136899.webp`.

## Remaining tasks

- Live end-to-end smoke of the new console in a real browser against a
  running network (all screens are covered by jsdom tests today).
- Incident detection & correlation with timelines (Phase 4).
- Validator operations — staking, session keys (Phase 5).
- Docker and Kubernetes/Helm deployment adapters (Phase 6).
- Peer-disconnect / partition faults (need reserved-only wiring or
  privileged isolation).
- Browser-wallet signing for anchors; refund the operator account for more
  contract anchors.

## Tech stack

TypeScript (Node 24), Fastify REST + WebSocket, SQLite, `@polkadot/api`,
Solidity 0.8.28 → pallet-revive, React 19 + Vite + framer-motion, Vitest.
