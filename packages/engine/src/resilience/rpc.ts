/**
 * Read-only Substrate JSON-RPC reader for chain-bound evidence (T-9.1).
 *
 * Uses only `chain_getHeader`, `chain_getFinalizedHead`, and
 * `chain_getBlockHash` over HTTP. Transport failures are surfaced as
 * `ChainUnreachableError` so verification can say "unverifiable: network
 * offline" instead of mistaking an outage for a mismatch.
 */

import { babeAuthorshipFromLogs } from "./babe";
import type { BlockRef, HeadReader } from "./evidence";

export class ChainUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnreachableError";
  }
}

export interface ChainReader extends HeadReader {
  /** Canonical hash at `number`, or null when the node has no such block. */
  blockHashAt(number: number): Promise<string | null>;
  genesisHash(): Promise<string | null>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpChainReaderOptions {
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface HeaderJson {
  number: string | number;
  parentHash?: string;
  digest?: { logs?: string[] };
}

export function createHttpChainReader(
  url: string,
  options: HttpChainReaderOptions = {},
): ChainReader {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  let genesis: string | null | undefined;

  async function call(
    method: string,
    params: unknown[] = [],
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ChainUnreachableError(
        `${method}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok)
      throw new ChainUnreachableError(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error)
      throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result;
  }

  async function hashAt(n: number): Promise<string | null> {
    const r = await call("chain_getBlockHash", [n]);
    return typeof r === "string" ? r.toLowerCase() : null;
  }

  async function headerOf(hash?: string): Promise<BlockRef> {
    const header = (await call(
      "chain_getHeader",
      hash ? [hash] : [],
    )) as HeaderJson | null;
    if (!header) throw new Error("chain_getHeader returned no header");
    const number =
      typeof header.number === "number"
        ? header.number
        : parseInt(header.number, 16);
    // A header does not carry its own hash; resolve it canonically by number
    // for the best block, and keep the caller-supplied hash otherwise.
    const resolved = hash ?? (await hashAt(number));
    if (!resolved) throw new Error(`no hash for block #${number}`);
    const ref: BlockRef = { number, hash: resolved.toLowerCase() };
    const a = babeAuthorshipFromLogs(header.digest?.logs ?? []);
    if (a)
      ref.author = {
        kind: a.kind,
        authorityIndex: a.authorityIndex,
        slot: a.slot,
      };
    return ref;
  }

  const reader: ChainReader = {
    async genesisHash() {
      if (genesis === undefined) genesis = await hashAt(0);
      return genesis;
    },
    blockHashAt: hashAt,
    async readHeads() {
      const finalizedHash = (await call("chain_getFinalizedHead")) as string;
      const [best, finalized] = await Promise.all([
        headerOf(),
        headerOf(finalizedHash),
      ]);
      return { best, finalized, genesisHash: await reader.genesisHash() };
    },
  };
  return reader;
}
