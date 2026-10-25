/**
 * Live commit-reveal orchestration (T-9.6 step 4).
 *
 *  commit: pick a target block N a few blocks ahead, submit the commit
 *          remark, and confirm the remark landed in a block BEFORE N.
 *  reveal: wait until N is FINALIZED, read hash(N), derive the drill.
 *
 * Talks to the chain only through `DrillLivePort`, so it is tested with a
 * scripted port and wired to V3 by `createV3DrillPort`.
 */

import { KaizenError } from "../errors";
import type { V3ChainSession, V3SubmitOptions } from "../v3/anchor/chain";
import type { KeyringPair } from "@polkadot/keyring/types";
import { drillCommitPayload } from "./drill-chain";
import type {
  DrillChainReader,
  DrillCommitProof,
  DrillEvidence,
} from "./drill-chain";
import type { DrillCommitment } from "./drill-commit";
import { deriveDrill } from "./drill-seed";
import type { DrillSeedBounds } from "./drill-seed";
import type { ChainReader } from "./rpc";

export interface DrillLivePort {
  heads(): Promise<{ best: number; finalized: number }>;
  blockHashAt(number: number): Promise<string | null>;
  /** Submit the commit remark; resolves once it is in a block. */
  submitCommit(payload: string): Promise<{
    blockNumber: number;
    blockHash: string;
    extrinsicIndex: number;
  }>;
}

/** What a committer must keep (or write to disk) until the reveal. */
export interface PendingDrill {
  commitment: DrillCommitment;
  commit: DrillCommitProof;
}

export const DEFAULT_DRILL_LEAD_BLOCKS = 12;

export async function commitDrill(
  port: DrillLivePort,
  validatorId: string,
  leadBlocks = DEFAULT_DRILL_LEAD_BLOCKS,
): Promise<PendingDrill> {
  if (!validatorId)
    throw new KaizenError("INVALID_INPUT", "validatorId is required");
  if (!Number.isSafeInteger(leadBlocks) || leadBlocks < 2)
    throw new KaizenError("INVALID_INPUT", "leadBlocks must be at least 2");
  const { best } = await port.heads();
  const targetBlock = best + leadBlocks;
  const r = await port.submitCommit(
    drillCommitPayload(validatorId, targetBlock),
  );
  if (r.blockNumber >= targetBlock)
    throw new KaizenError(
      "DRILL_COMMIT_TOO_LATE",
      `commit landed in #${r.blockNumber}, not before target #${targetBlock}; commit again with a larger lead`,
    );
  return {
    commitment: { validatorId, committedAtBlock: r.blockNumber, targetBlock },
    commit: { blockHash: r.blockHash, extrinsicIndex: r.extrinsicIndex },
  };
}

export interface RevealOptions {
  pollMs?: number;
  timeoutMs?: number;
  bounds?: DrillSeedBounds;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function revealDrill(
  port: DrillLivePort,
  pending: PendingDrill,
  options: RevealOptions = {},
): Promise<DrillEvidence> {
  const pollMs = options.pollMs ?? 6_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const sleep =
    options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const target = pending.commitment.targetBlock;
  let finalized = (await port.heads()).finalized;
  while (finalized < target) {
    if (now() - started > timeoutMs)
      throw new KaizenError(
        "DRILL_REVEAL_TIMEOUT",
        `block #${target} not finalized after ${timeoutMs} ms (finalized #${finalized})`,
      );
    await sleep(pollMs);
    finalized = (await port.heads()).finalized;
  }
  const seedBlockHash = await port.blockHashAt(target);
  if (!seedBlockHash)
    throw new KaizenError(
      "DRILL_REVEAL_TIMEOUT",
      `no hash for finalized block #${target}`,
    );
  const beaconGenesisHash = await port.blockHashAt(0);
  return {
    ...(beaconGenesisHash ? { beaconGenesisHash } : {}),
    commitment: pending.commitment,
    seedBlockHash,
    finalizedAtReveal: finalized,
    claimed: deriveDrill({
      validatorId: pending.commitment.validatorId,
      seedBlockHash,
      bounds: options.bounds,
    }),
    commit: pending.commit,
  };
}

/** Wire the orchestration to V3: heads over HTTP RPC, remarks via polkadot.js. */
export function createV3DrillPort(
  session: V3ChainSession,
  reader: ChainReader,
  signer: KeyringPair,
  submit: V3SubmitOptions = {
    inclusionTimeoutMs: 120_000,
    finalityTimeoutMs: 0,
  },
): DrillLivePort {
  return {
    async heads() {
      const h = await reader.readHeads();
      return { best: h.best.number, finalized: h.finalized.number };
    },
    blockHashAt: (n) => reader.blockHashAt(n),
    async submitCommit(payload) {
      const r = await session.submitRemark(signer, payload, submit);
      return {
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        extrinsicIndex: r.extrinsicIndex,
      };
    },
  };
}

/** Verification reader over a V3 session (block hashes + remark text). */
export function v3DrillChainReader(session: V3ChainSession): DrillChainReader {
  return {
    blockHashAt: (n) => session.blockHashAt(n),
    remarkAt: (h, i) => session.remarkAt(h, i),
  };
}
