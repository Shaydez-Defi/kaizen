# Resilience Score — specification (v1)

Status: IMPLEMENTED (T-9.3) — `packages/engine/src/resilience/score.ts`,
pinned by `packages/engine/test/resilience-score.test.ts`. Decision: DEC-029.

The resilience score is a **0–100 number per validator** computed from the
validator's **certified** Failure Lab runs. It is a pure, deterministic
function: anyone holding the certificates can recompute it. Kaizen never
shows a score it did not compute from certificates.

## 1. Inputs: certified runs

A certified run is a `ResilienceCertificate` (T-9.2): the finished run
record plus **chain evidence** — best and finalized heads (number + hash)
observed by a reference node before the fault, during it, and after
recovery — fingerprinted with SHA-256 over canonical JSON and signed with
the operator's sr25519 key.

Certificates whose integrity check fails (fingerprint or signature) are
**excluded**. Certificates whose chain binding is `unverifiable` (e.g. the
local network has since been stopped) still count — the score always
reports how many inputs it used, and `kaizen score --verify` shows each
certificate's verdict. Certificates signed with the public DEV key are
labelled; they prove integrity, not operator identity.

## 2. Per-run metrics (from chain evidence)

All three are derived by `computeRecoveryMetrics` from the observations
alone; a metric that cannot be derived is `null`.

| Metric | Definition |
|---|---|
| `recovered` | some after-recovery observation has a finalized number strictly greater than every finalized number observed before/during the fault (block production without finality is **not** recovery) |
| `timeToRecoverMs` | first recovered observation time − fault end time (fault start if no end was recorded) |
| `finalityGapBlocks` | max over during/after observations of `best.number − finalized.number` |
| `blocksMissed` | `floor(elapsed / expectedBlockTime) − produced`, clamped at 0, where elapsed and produced span the last before-fault to the last during-fault observation; `expectedBlockTime` defaults to 6 000 ms and is recorded in the evidence |

## 3. Formula

Per run *i*:

```
survived_i = recovered_i AND state_i ∈ {completed, completed-with-warnings}
R_i = 1 / (1 + timeToRecoverMs_i / 60 000)      null → 0
F_i = 1 / (1 + finalityGapBlocks_i / 10)        null → 0
M_i = 1 / (1 + blocksMissed_i / 10)             null → 0
q_i = survived_i ? 0.5·R_i + 0.3·F_i + 0.2·M_i : 0
w_i = 0.5 ^ (ageDays_i / 30)                    age from certification time; future → 0
```

Aggregate:

```
quality    = Σ w_i·q_i / Σ w_i                  (0 when there are no runs)
confidence = 1 − e^(−Σ w_i / 2)
score      = round(100 · quality · confidence), clamped to [0, 100]
```

Rationale:

- **Recovery time dominates (0.5)** — the question a delegator or network
  operator asks is "how fast does finality come back after this validator
  is hit?" A 60 s recovery halves R.
- **Finality gap (0.3)** measures how far finality fell behind production;
  10 blocks halves F.
- **Liveness (0.2)** penalises missed slots during the fault window; 10
  missed blocks halves M.
- **Failed runs count as 0** and still carry weight, so failures pull the
  score down rather than being ignored.
- **Recency decay (30-day half-life)** — resilience must be re-proven;
  old runs fade.
- **Confidence** stops one lucky run from scoring high: one fresh run caps
  at ≈39, five at ≈92, ten at ≈99.

Parameters are exported as `RESILIENCE_SCORE_PARAMS`; changing any of them
is a new score version (`RESILIENCE_SCORE_VERSION`).

## 4. Worked examples (pinned by tests)

"Typical" run: recovered, `completed`, ttr 12 s, gap 6, missed 6 → q ≈ 0.729.

| # | Certified runs (as of 2026-10-24) | Score |
|---|---|---|
| A | one fresh typical run | 29 |
| B | five fresh typical runs | 67 |
| C | five fresh perfect runs (0 s, gap 0, missed 0) | 92 |
| D | four fresh typical + one failed | 54 |
| E | five typical runs, all 30 days old | 52 |
| F | ten fresh perfect runs | 99 |

## 5. On-chain form

`KaizenResilienceRegistry` (contracts/) stores per-validator certificates
(fingerprint, sr25519 signer key, metrics, score, timestamp) and exposes
`getLatest` / `getScore`. The **contract does not compute the score** (no
floating point or sr25519 verification in the EVM); it stores the score
the operator computed with this spec next to the inputs, so anyone can
recompute it from the certificates and compare. The signature itself is
emitted in the `CertificateRecorded` event (not stored) and is verified
off-chain by `kaizen score --verify` / the API.

## 6. Limits (honest scope)

- Evidence comes from one reference observer node per run; a partitioned
  observer would see its own fork (verification then reports `mismatch`).
- `blocksMissed` assumes a fixed slot time; it is a liveness signal, not a
  slashing-grade measure.
- Scores from local test networks show what the validator setup survives
  under Kaizen's fault catalogue (pause, terminate); they are not a claim
  about mainnet behaviour.
