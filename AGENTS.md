# AGENTS.md — Build Governance for Kaizen

Durable instructions for future OpenCode sessions (and any AI agent) working
in this repository. Non-negotiable unless a documented decision changes them.

## Before You Start (every session)

1. Read, in order: `AGENTS.md` (this file), `docs/PROJECT_SPEC.md`,
   `docs/IMPLEMENTATION_PLAN.md`, `docs/PROGRESS.md`, then the relevant
   architecture/research docs (`docs/ARCHITECTURE.md`,
   `docs/TECHNICAL_RESEARCH.md`, `docs/RISKS.md`, `docs/DECISIONS.md`).
2. Inspect the current state: `git status`, `git log --oneline -10`, and read
   the files you plan to edit **before** editing them.
3. Identify exactly one phase/task you are working on (e.g. "T-1.4"). If the
   intended work doesn't map to a task, stop and either create one in
   `docs/IMPLEMENTATION_PLAN.md` or ask.

## Scope & Product Integrity

- Preserve the locked product scope in `docs/PROJECT_SPEC.md`. Do not add
  unrelated features or unnecessary dependencies.
- The backend owns all infrastructure operations. The web UI must never
  control host processes or execute arbitrary shell commands.
- The CLI and web UI must call the shared engine (`packages/engine`). Never
  duplicate operation logic (network creation, node control, scenarios) in
  the CLI, API, or UI layers.
- **Never fabricate** integrations, test results, command outputs, feature
  completion, or data. UI/CLI render only real RPC/process/history data. An
  unimplemented feature is labeled as such — never faked (DEC-009).
- Kubernetes/Helm (P2 wow-factor) stays in planned scope. If blocked,
  investigate, document evidence, propose a fallback — never silently remove
  it (spec §6.6).

## Working Rules

- One clearly defined phase/task at a time. Finish it (code + tests +
  documentation + log) before starting another.
- Inspect existing code before editing; do not replace working code without a
  demonstrated reason. Never discard uncommitted user work; never amend/rebase
  shared history — additive commits only.
- Use typed interfaces (TypeScript strict) and validate all inputs at system
  boundaries (Zod). Handle errors explicitly; no swallowed rejections; every
  failure path yields an actionable, structured message.
- Process execution: argv arrays only (never shell strings), allowlisted flags,
  timeouts, cancellation, and cleanup (no orphan processes). Secrets never via
  argv, never logged, never committed (node keys, keystore passwords,
  credentials, machine-specific config). `.kaizen/` is runtime state and must
  stay gitignored.
- Add or update tests alongside implementation. Run the relevant tests and
  builds before marking any work complete (`npm test`, `npm run build`, and
  for real-node work `KAIZEN_TEST_LIVE=1 npm run test:integration`).
- Avoid adding dependencies without justification in the PR/commit message.

## Evidence & Status Discipline

- `IMPLEMENTED` and `VERIFIED` are **not** interchangeable. A task is VERIFIED
  only after its stated acceptance criteria were tested and the evidence
  (commands + actual results) recorded in `docs/PROGRESS.md`.
- Research facts live in `docs/TECHNICAL_RESEARCH.md` with the fixed status
  vocabulary: VERIFIED / PARTIALLY VERIFIED / UNVERIFIED / BLOCKED. Update
  statuses when evidence changes; never upgrade a status without evidence.
- Report blocked work honestly and name the next concrete action. Never claim
  production-readiness because a UI exists.
- Every meaningful task updates `docs/PROGRESS.md` (chronological log) and any
  affected docs. Progress reported only in chat is not acceptable.

## Verification Expectations

- Claims about Portaldot must be confirmed against the real binary/runtime,
  not assumed from generic Substrate docs. If the environment prevents
  verification, record the limitation and the exact command/experiment needed
  later (see `docs/TECHNICAL_RESEARCH.md` format).
- Integration tests must clean up all spawned processes and use the engine's
  port allocator; leaked `portaldot_dev` processes fail the suite.
- Do not connect to, or operate against, Portaldot mainnet. Destructive and
  failure-injection operations are gated to designated test networks
  (DEC-008); keep that gate intact.

## Git Discipline

- Additive commits only; one reviewable unit of work per commit (task-sized).
- Commit message: `<type>: <summary>` (feat/fix/docs/test/chore/refactor) with
  body referencing task IDs (e.g. `feat: node process manager (T-1.4)`).
- Never commit: secrets, keys, credentials, large binaries, `.kaizen/` state,
  or machine-specific paths.
- The repo must stay suitable for a public GitHub repository and a
  reproducible demo (README quickstart must work from a clean clone).

## When You Finish a Task

1. Tests/builds green (state exactly what you ran and the result).
2. Update `docs/PROGRESS.md` with the entry (date, task IDs, files, commands,
   actual results, problems, decisions, remaining work, exact next step).
3. Update task status in `docs/IMPLEMENTATION_PLAN.md` and any flipped
   statuses in `docs/TECHNICAL_RESEARCH.md` / `docs/RISKS.md`.
4. Commit the unit of work.
5. Report: what was done, what was verified, what remains, the next action.
