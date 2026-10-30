# Kaizen

Kaizen regularly tests Portaldot validators (computers that help keep the network running). It saves what each test found and can publish that proof on the Portaldot V3 test network, so anyone can check how the validators did.

[![Resilience](https://kaizen-live.vercel.app/api/badge)](https://kaizen-live.vercel.app)

## The problem

Validator operators need a way to show that their computers can keep working when something goes wrong. A dashboard or a claim alone cannot prove that a problem happened, that the network recovered, or that the saved proof is real. Kaizen makes each test clear, guarded, saved, and possible for other people to check.

## How it works

Kaizen uses one shared TypeScript engine (the program that does the work) to manage networks and computers, watch their health, run supported failure tests, save proof, and make certificates. The command-line tool (CLI, where you type commands) and HTTP API (a way for other programs to ask Kaizen to do things) use that same engine. The React web console (the website you can click) gets its information through the API and shows what the engine found.

The engine makes throwaway Portaldot test networks, checks whether nodes answer, and can run supported failure tests when asked. Safety checks only allow dangerous actions on approved local or development test networks. Kaizen saves each test, its steps, and the proof it collected. Certificates can check and publish that proof on the blockchain, a shared record that people can inspect. Kaizen does not pretend it saw results that were not observed.

## Quickstart

Requirements: Node.js 24 or newer, npm, and a supported Linux or macOS computer with an x86_64 processor (a common kind of computer chip). First setup needs internet access to download the Portaldot node program. Each running node needs about 1 GiB of free memory.

From a clean clone, run:

```bash
git clone https://github.com/Shaydez-Defi/kaizen.git
cd kaizen
npm ci
npm run build
npm test
```

The workspace scripts and runtime packages (small groups of program files) are listed in `package.json` and the package lists. `npm install` downloads the programs Kaizen needs, `npm run build` prepares the engine, CLI, API, and website to run, and `npm test` checks that small parts work as expected. A separate real-node test can be run when asked; it needs `portaldot_dev` (the Portaldot node program) and `KAIZEN_TEST_LIVE=1`, as explained in [Testing](docs/TESTING.md). The hosted console shows the public live view at https://kaizen-live.vercel.app.

## Evidence and on-chain anchoring

The live drill workflow runs real tests on the network in CI every three hours. It saves proof from each test and publishes that proof through the configured Portaldot V3 test-network process. The public live console at https://kaizen-live.vercel.app shows the live proof that is available. The drill signer is `5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR`.

Kaizen only reports that a test was run or proof published when the saved result shows that it happened. See [the architecture](docs/ARCHITECTURE.md), [the technical research record](docs/TECHNICAL_RESEARCH.md), and [the testing evidence](docs/TESTING.md) to learn what is checked and what the proof does not cover.

## Roadmap

The implementation plan and progress log describe the current state and remaining work. Planned areas include deployment adapters for Docker and Kubernetes/Helm, additional validator operations, and broader end-to-end verification. Planned capabilities are not represented as completed features. See [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) and [Progress](docs/PROGRESS.md).

## Documentation

- [Project specification](docs/PROJECT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Technical research](docs/TECHNICAL_RESEARCH.md)
- [Risk register](docs/RISKS.md)
- [Decision records](docs/DECISIONS.md)
- [Progress log](docs/PROGRESS.md)
- [Testing strategy and evidence](docs/TESTING.md)
- [Phase reports](docs/PHASE_REPORT.md)

## License

Kaizen is released under the MIT License. See [LICENSE](LICENSE) for the complete terms.
