/**
 * V3 wiring for commit-reveal drills (T-9.6 step 4): connects with the
 * configured endpoints, signs the commit remark with KAIZEN_V3_SIGNER_SURI
 * (costs a transaction fee only), and reads heads over the public HTTPS RPC.
 */

import { PolkadotV3ChainConnector } from "../v3/anchor/chain";
import { loadV3Signer } from "../v3/anchor/signer";
import { resolveV3Config } from "../v3/config";
import {
  commitDrill,
  createV3DrillPort,
  revealDrill,
  v3DrillChainReader,
} from "./drill-live";
import type { PendingDrill } from "./drill-live";
import type { DrillChainReader, DrillEvidence } from "./drill-chain";
import { createHttpChainReader } from "./rpc";

function httpOf(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

async function withV3<T>(
  fn: (
    session: import("../v3/anchor/chain").V3ChainSession,
    reader: ReturnType<typeof createHttpChainReader>,
  ) => Promise<T>,
): Promise<T> {
  const cfg = resolveV3Config();
  const session = await new PolkadotV3ChainConnector().connect(
    cfg.substrateWsUrl,
    { connectTimeoutMs: 20_000 },
  );
  try {
    return await fn(session, createHttpChainReader(httpOf(cfg.substrateWsUrl)));
  } finally {
    await session.close();
  }
}

export async function commitDrillOnV3(
  validatorId: string,
  leadBlocks?: number,
): Promise<PendingDrill> {
  const signer = await loadV3Signer();
  return withV3((session, reader) =>
    commitDrill(
      createV3DrillPort(session, reader, signer.pair),
      validatorId,
      leadBlocks,
    ),
  );
}

export async function revealDrillOnV3(
  pending: PendingDrill,
  timeoutMs?: number,
): Promise<DrillEvidence> {
  return withV3(async (session, reader) => {
    // reveal only reads; the pair is never used for signing here
    const signer = await loadV3Signer();
    return revealDrill(
      createV3DrillPort(session, reader, signer.pair),
      pending,
      { timeoutMs },
    );
  });
}

/** Run `fn` with a verification reader backed by a live V3 session. */
export async function withV3DrillReader<T>(
  fn: (reader: DrillChainReader) => Promise<T>,
): Promise<T> {
  return withV3((session) => fn(v3DrillChainReader(session)));
}
