# Kaizen

Kaizen is a Proof-of-Resilience platform for Portaldot validators. It combines node operations, controlled resilience drills, signed run certificates, and chain-bound evidence in a shared engine used by a web console and command-line interface.

The project is built for reproducible validator development and testing. It provides operators with tools to create local networks, observe their state, run guarded scenarios, recover from faults, and verify evidence against the chain. Kaizen is not a hosted validator service, a block explorer, or a production key-custody system.

## The problem

Validator readiness is often described through availability metrics and operator reports. Those signals can show that a node is running, but they do not by themselves establish how it behaves during a failure or whether it recovers in a way that is visible on-chain. Reproducing drills and reviewing their evidence can also require separate scripts, process logs, and chain queries.

Kaizen brings these steps together. It records operations against real node processes, applies explicit safety gates to failure experiments, and associates run results with chain observations. Claims are limited to the evidence the software actually captures and verifies.

## How it works

Kaizen uses a modular TypeScript engine shared by its CLI and web console. The CLI calls engine services directly. The web console uses a typed HTTP API and WebSocket event stream. The engine manages node processes and network configuration, samples node RPC and process state, executes scenario steps through guarded adapters, and persists operational records in SQLite.

A typical workflow creates a designated test network, monitors its nodes, executes a supported failure scenario, observes recovery, and inspects the resulting run record. The current implemented failure mechanisms include pause and terminate. Peer-disconnect and partition operations remain blocked and are not represented as working capabilities.

## Proof-of-Resilience and evidence

Kaizen captures best and finalized chain heads, including their hashes, around a drill. Certificate fingerprints are computed from canonical JSON containing the run and chain evidence, and are signed with sr25519. Certificate verification checks the fingerprint and signature and re-fetches the referenced block hashes. Recovery is reported only when the observed finality advances past the highest pre-fault or during-fault value.

The current v1 score is an open, documented formula. It includes measured recovery time as its largest weight. The score is computed by Kaizen and is not calculated by the registry contract. The v1 evidence model establishes integrity and chain binding; it does not establish that drills were unpredictable. Future-block-hash-seeded drills, BABE authorship evidence, and evidence-class weighting are roadmap items.

Kaizen also supports explicit run anchoring on the Portaldot V3 test network. The `drill-live` CI workflow anchors evidence every three hours. Anchoring is operator-signed, and the configured signer address is `5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR`. The live console is available at https://kaizen-live.vercel.app. Each anchor type and transaction outcome should be interpreted according to its recorded chain evidence; an attempted write alone is not proof of a successful anchor.

## Quickstart

The commands below assume a clean clone, Node.js 24, npm, and a supported Portaldot development binary environment. Consult the repository's package scripts and current CLI help if a command differs in a local checkout.

```bash
git clone https://github.com/Shaydez-Defi/kaizen.git
cd kaizen
npm install
npm run build
npm test
```

To launch the development console, use the repository development script:

```bash
npm run dev
```

The application manages local Portaldot node processes. Before running a network or failure scenario, review the CLI help and ensure the target is a disposable, designated test network. Do not use production validator keys or mainnet targets for failure drills.

## Roadmap

The roadmap includes unpredictable drill scheduling from future block hashes, BABE authorship evidence, and evidence-class weighting. Further planned areas include incident detection and correlation, validator staking and session-key operations, and Docker or Kubernetes deployment. These items are not described as implemented capabilities.

## License

Kaizen is distributed under the MIT License. See the repository's `LICENSE` file for the full license text.

## Documentation

The `docs/` directory contains the project specification, architecture, implementation plan, technical research, risk register, decision records, progress evidence, testing guidance, and attestation specification. Status labels and reported evidence in those documents reflect the state recorded in the repository and should not be interpreted as claims beyond their stated scope.
