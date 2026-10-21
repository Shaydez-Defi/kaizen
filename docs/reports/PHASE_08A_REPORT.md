# Phase 8 Report (partial) — Portaldot V3 Connectivity Probe (T-8.1)

**Date**: 2026-10-19
**Tasks**: T-8.1 ONLY. Contract deployment, registry contracts, wallet
authorization, any later T-8.x task, T-3.6 CLI/UI surfaces, and Phases 4–7
were explicitly out of scope and were NOT implemented. No `PHASE_8_PLAN.md`
existed in the repo or was supplied — the Phase 8 section in
`docs/IMPLEMENTATION_PLAN.md` records the task exactly as briefed.

---

## 1. Task & scope

Deliver a narrowly scoped, typed Portaldot V3 endpoint configuration and
connectivity probe: the official V3 endpoints (Substrate WS, EVM JSON-RPC,
Explorer) as overridable configuration defaults; independent read-only
probes of each surface with typed, structured results; mocked-transport
unit tests that need no internet; an environment-gated live probe against
the real endpoints; documentation and evidence — nothing else.

**Scope guardrails honored**: no UI screens, no API route, no
arbitrary-URL probing surface, no chain writes/signing/wallet operations,
no new dependencies, no README/provenance edits, unit suite stays offline.

---

## 2. Architecture & files changed

Configuration resolves as **explicit option > `KAIZEN_V3_*` env > trusted
default**, validated with Zod (validation errors name KEYS, never values).
`V3ConnectivityProbe` depends on three transport interfaces (DI — unit
tests inject fakes); the real transports reuse existing stacks:
`PortaldotRpcClient` (`@polkadot/api`, DEC-001) for Substrate WS and the
engine's `fetch` HTTP stack for JSON-RPC/HTTP. Each endpoint probe is
wrapped in a hard per-endpoint deadline (AbortController + `Promise.race`)
whose abort signal drives transport cleanup; `probeAll()` runs the three
probes in parallel, each individually wrapped — one failing endpoint can
never suppress or short-circuit a sibling's result, and the probe never
rejects. Results are credential-free by construction: endpoints appear
origin-redacted (`redactEndpointUrl`), messages are sanitized (configured
URLs → origins, userinfo stripped generically, shared `redactSecrets`
scrubber), and unobserved values are `null`, never guessed.

| File | Change |
|------|--------|
| `packages/engine/src/v3/config.ts` | **new** — `V3_ENDPOINT_DEFAULTS`, `V3_ENV_KEYS`, `resolveV3Config()`, `redactEndpointUrl()` |
| `packages/engine/src/v3/types.ts` | **new** — `V3ProbeStatus`, `V3EndpointProbeResult`, `V3ConnectivityReport`, per-role observation types |
| `packages/engine/src/v3/probe.ts` | **new** — `V3ConnectivityProbe`, `probeV3Connectivity()`, deadline/cleanup, validation, status model, sanitization |
| `packages/engine/src/v3/transports.ts` | **new** — transport DI interfaces + `RealSubstrateTransport`, `FetchJsonRpcTransport`, `FetchHttpAvailabilityTransport` |
| `packages/engine/src/rpc/client.ts` | **modified (additive)** — `SubstrateProbeRead`, `PortaldotRpcClient.probeReads()` (three parallel read-only calls), one-shot `readProbeState()` with guaranteed close |
| `packages/engine/src/index.ts` | **modified** — exports for the v3 module (service, config, transports, types) |
| `packages/engine/test/v3-probe.test.ts` | **new** — 21 unit tests, all transports faked, offline |
| `test/integration/v3-probe.int.test.ts` | **new** — live probe, own gate `KAIZEN_TEST_V3=1` |
| `docs/IMPLEMENTATION_PLAN.md` | new Phase 8 section + T-8.1 row (VERIFIED) |
| `docs/TECHNICAL_RESEARCH.md` | R-23 (V3 endpoints, VERIFIED), R-24 (explorer, PARTIALLY VERIFIED) + summary-matrix rows |
| `docs/ARCHITECTURE.md` | component-table row for `V3ConnectivityProbe`; §5 V3 external-endpoint boundary |
| `docs/DECISIONS.md` | DEC-023 |
| `docs/RISKS.md` | RSK-29 |
| `docs/TESTING.md` | §15 (unit + live + commands/results) |
| `docs/PROGRESS.md` | 2026-10-19 T-8.1 entry |
| `docs/reports/PHASE_03E_REPORT.md` | **new** — Phase 3E report archived verbatim (`cmp` byte-identical) |

---

## 3. Acceptance criteria (PASS / FAIL / BLOCKED) with evidence

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Official V3 endpoints are configuration defaults, overridable via options/env | **PASS** | `V3_ENDPOINT_DEFAULTS` + `resolveV3Config()`; unit tests "uses the official V3 endpoints as overridable defaults", "applies env overrides, with explicit options winning over env" |
| 2 | Substrate WS probe: connect, chain name, system health, best header/height | **PASS** | unit (fake transport, ok + malformed variants); live: chain "PortaldotV3 Test", health {peers 2, not syncing}, best #106135 — `[v3-live]` log, R-23 |
| 3 | EVM probe: `eth_chainId`, `eth_blockNumber`, optional `web3_clientVersion`; JSON-RPC envelope/ID validation | **PASS** | unit (envelope/id/version/error-object/non-2xx/non-JSON cases); live: chain id 420420777, block #106135, client `eth-rpc/main-fddd431…` |
| 4 | Wrong chain ID = mismatch, never success; HTTP 200 alone ≠ healthy | **PASS** | unit "reports an unexpected chain id as mismatch…" (observed 100 → `mismatch`, healthy false); "200 + non-JSON body → malformed-response"; "JSON-RPC error object with HTTP 200 → protocol-error" |
| 5 | Typed results distinguishing connection failure / timeout / protocol-RPC failure / malformed response / success | **PASS** | `V3ProbeStatus = ok \| unavailable \| timeout \| protocol-error \| malformed-response \| mismatch`; unit tests assert each classification (incl. instant transport-code classification, not deadline waiting) |
| 6 | Endpoints probed independently; one failure never short-circuits another | **PASS** | unit: substrate down + EVM up; EVM down + substrate up; all-three-fail-differently test — three results always returned |
| 7 | Deterministic cleanup on success, failure, and timeout | **PASS** | unit: hung transport → `timeout` within deadline, `signal.aborted` + abort-counter asserted; `readProbeState()` closes in `finally`; real transports honor abort (offline pre-aborted-signal test); live run leaves no processes |
| 8 | Explorer: lightweight availability check implemented; scope documented (no scraper, no new dependency) | **PASS** (availability-only, deliberately) | bounded 2 KiB fetch GET; result carries scope warning; R-24 records PARTIALLY VERIFIED with what is and is not verifiable |
| 9 | No secrets/credentials/tokens/full credential-bearing URLs in results or logs | **PASS** | unit "never leaks credentials from config or error messages into any result" (serialized report contains zero occurrences of userinfo/path/query material); redaction is structural (origin-only endpoints) |
| 10 | No chain writes/signing/wallet/staking/deployment/funding/runtime capability discovery | **PASS** | read-only by construction + unit "performs read-only protocol calls…" (method allowlist, empty params, no header/auth inputs) |
| 11 | No unrestricted arbitrary-URL probing surface; existing security conventions kept | **PASS** | no route, no request input, no URL parameter exists (DEC-023); config is the only target source |
| 12 | Unit suite requires no internet; live check explicitly environment-gated | **PASS** | 21 mocked tests offline (fakes for all transports); live file gated `KAIZEN_TEST_V3=1`; ungated run verified `1 skipped` (never "passed") |
| 13 | Live probe ran on the configured endpoints; observations recorded with timestamps; no skipped/blocked check reported as passed | **PASS** | `KAIZEN_TEST_V3=1 … v3-probe.int.test.ts` → 1/1 PASS (exit 0); `[v3-live]` report at 2026-10-19T17:51:03Z logged; R-23/R-24/TESTING §15 record the values |
| 14 | Supplied-config-vs-observed comparison performed | **PASS** | expected chain id 420420777 CONFIRMED by `eth_chainId` (`0x190f1ca9`) — no mismatch; heights advance between runs (live chain), recorded as evidence |
| 15 | Documentation updated without historical rewrites; progress logged; report archived | **PASS** | Phase 3E report archived byte-identical (`cmp`); IMPLEMENTATION_PLAN/PROGRESS/ARCHITECTURE/DECISIONS/RISKS/TESTING/TECHNICAL_RESEARCH updated (additive) |

No criterion is FAIL or BLOCKED.

---

## 4. Exact commands and results (2026-10-19)

| Command | Result |
|---------|--------|
| `npm run build` | PASS — exit 0 (engine/cli/api/web) |
| `npm run typecheck` | PASS — exit 0 |
| `npm run lint` | PASS — exit 0 |
| `npm test` | First run: **282/283** — one failure in `scenario-run.test.ts` ("stand-in node could not listen on 34741": transient local port-bind contention in the T-3.4 harness; no V3 code involved). Isolated re-run of that file: **37/37 PASS**. Second full run: **283/283 (25 files) PASS** — exit 0 |
| `npx vitest run --config vitest.integration.config.mts test/integration/v3-probe.int.test.ts` (no gate) | **1 skipped** — the live check does not pass without its gate |
| `KAIZEN_TEST_V3=1 npx vitest run --config vitest.integration.config.mts test/integration/v3-probe.int.test.ts` | **1/1 PASS** — exit 0 (3.1 s) |
| `pgrep -af portaldot` after the live run | none — no orphaned processes/connections |

---

## 5. Mocked vs live evidence (kept separate)

**Mocked (offline, deterministic — `packages/engine/test/v3-probe.test.ts`,
21/21)**: every required behavior — independence, all six statuses, timeout
+ cleanup signalling, envelope/id/version validation, JSON-RPC errors,
mismatch, malformed heights/headers/health, optional-method warnings,
credential redaction, config precedence, read-only allowlists, single-
endpoint contract — is proven against INJECTED FAKES. These results say
nothing about the real endpoints; they prove the probe's logic.

**Live (real endpoints — `test/integration/v3-probe.int.test.ts`, 1/1 with
gate `KAIZEN_TEST_V3=1`, 2026-10-19T17:51Z)**:

| Endpoint | Status | Observations (verbatim from the `[v3-live]` report) |
|----------|--------|------------------------------------------------------|
| `wss://test-node-v3.portaldot.dev` | `ok` (3130 ms) | chain **"PortaldotV3 Test"**; health **{peers: 2, isSyncing: false, shouldHavePeers: false}**; best **#106135**, hash `0x30c7b26621554e0f11cade516994cec379ad9079cbf2a34da9dfbc208d0cab66` |
| `https://test-evm-rpc-v3.portaldot.dev` | `ok` (1553 ms) | `eth_chainId` **420420777** (`0x190f1ca9`, matches configured expectation); `eth_blockNumber` **#106135** — same height as the Substrate head (one chain, two surfaces); `web3_clientVersion` **"eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0"** |
| `https://node-console.portaldot.dev` | `ok` (888 ms) | **HTTP 200**, `text/html`, document title **"Portaldot Node Console"** (bounded 2 KiB read); availability-only scope recorded in the result's warnings |

Overall: `healthy: true`; report timestamps 2026-10-19T17:51:00.66–03.79Z;
endpoints origin-redacted; zero credentials. Manual pre-checks (curl POST
`eth_chainId`; Node `ws` reads) at 17:27–17:28 UTC agreed and showed the
chain advancing (#105907 → #106135), corroborating a live chain.

---

## 6. What was NOT implemented (deliberate scope boundaries)

- No API route or UI surface for the probe (DEC-023: config-only targets;
  a future surface must keep that posture).
- No contract deployment, registry contracts, wallet authorization, or any
  later T-8.x task — undefined without a brief; not started.
- No T-3.6 CLI/UI surfaces; Phases 4–7 untouched.
- No EVM library (ethers/viem), no headless browser, no explorer scraper.
- No deep explorer verification (SPA data views) — documented as PARTIALLY
  VERIFIED in R-24 rather than overclaimed.
- No `docs/EVIDENCE.md` — it does not exist, and AGENTS.md fixes research
  facts in `docs/TECHNICAL_RESEARCH.md` (R-23/R-24); live vs mocked
  evidence is separated here and in TESTING §15.
- No changes to mainnet posture (DEC-008 intact — the probe is read-only
  against designated public test endpoints only; it cannot touch a local
  managed network's control plane).

---

## 7. Security considerations & risks

- **SSRF/absteering**: impossible by construction — the probe accepts no
  request input and no URL; only explicit options and `KAIZEN_V3_*` env
  (trusted operator configuration) select targets (DEC-023).
- **Credential leakage**: endpoint URLs may carry userinfo/path/query
  secrets in overridden environments; results embed origin-only forms,
  messages are sanitized (config-URL → origin, generic userinfo strip,
  `redactSecrets`), and config-validation errors name keys, never values —
  all unit-tested.
- **Read-only guarantee**: EVM calls are a fixed allowlist with empty
  params; substrate reads go through the existing client's read-only
  path; no signing, auth headers, or state-changing methods exist in the
  module.
- **New risk recorded**: **RSK-29** (live check depends on external
  endpoint availability) — mitigated by the dedicated gate (ungated =
  skipped, verified), the fully offline unit suite, and honest typed
  `unavailable`/`timeout` statuses that are never converted to healthy.

---

## 8. Cleanup / resource-release verification

- The Substrate one-shot helper closes the WS connection in `finally` on
  success, failure, and timeout; the probe's per-endpoint AbortController
  fires on the hard deadline, and transports stop work on abort (fetch
  `AbortSignal.any`; the real substrate transport rejects on abort and the
  client's own deadlines close the socket).
- Unit suite asserts the cleanup SIGNAL (`signal.aborted` true, abort
  listener fired exactly once) and bounded elapsed time with a hung
  transport; `RealSubstrateTransport`'s pre-aborted path is exercised
  offline.
- Live run hygiene: `pgrep -af portaldot` after → none; the probe opens no
  long-lived resources (no listeners, no ports).

---

## 9. Remaining work & next task

- **Remaining (not started by instruction)**: later V3 integration tasks
  (contract deployment, registry, wallet authorization) — each requires
  its own brief; explorer deep-checks only if a published API surface
  justifies it (R-24).
- **Next roadmap task when resumed**: **T-3.6** — Failure Lab CLI/API and
  UI integration surfaces, calling `engine.scenarioRuns.execute()` /
  `.replay()` exactly like the API does. Per instruction, work STOPPED
  after T-8.1.
