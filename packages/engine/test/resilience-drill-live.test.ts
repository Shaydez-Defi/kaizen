import { describe, expect, it } from "vitest";
import {
  commitDrill,
  deriveDrill,
  drillCommitPayload,
  revealDrill,
  verifyDrillEvidence,
  type DrillLivePort,
} from "@kaizen/engine";
import { hashOf } from "./resilience-fixtures";

function port(over: Partial<DrillLivePort> & { land?: number } = {}) {
  const sent: string[] = [];
  let finalized = 100;
  const p: DrillLivePort = {
    async heads() {
      const f = finalized;
      finalized += 3; // chain advances between polls
      return { best: 105, finalized: f };
    },
    blockHashAt: async (n) => hashOf(n),
    async submitCommit(payload) {
      sent.push(payload);
      return {
        blockNumber: over.land ?? 106,
        blockHash: hashOf(over.land ?? 106),
        extrinsicIndex: 1,
      };
    },
    ...over,
  };
  return { p, sent };
}

describe("commitDrill / revealDrill", () => {
  it("commits to a future block, waits for finality, then reveals the seeded drill", async () => {
    const { p, sent } = port();
    const pending = await commitDrill(p, "bob", 12);
    expect(pending.commitment).toEqual({
      validatorId: "bob",
      committedAtBlock: 106,
      targetBlock: 117,
    });
    expect(sent).toEqual([drillCommitPayload("bob", 117)]);

    let slept = 0;
    const ev = await revealDrill(p, pending, {
      sleep: async () => {
        slept++;
      },
    });
    expect(slept).toBeGreaterThan(0);
    expect(ev.seedBlockHash).toBe(hashOf(117));
    expect(ev.finalizedAtReveal).toBeGreaterThanOrEqual(117);
    expect(ev.claimed).toEqual(
      deriveDrill({ validatorId: "bob", seedBlockHash: hashOf(117) }),
    );
    const check = await verifyDrillEvidence(ev, {
      blockHashAt: async (n) => hashOf(n),
      remarkAt: async () => sent[0]!,
    });
    expect(check.status).toBe("verified");
  });

  it("refuses a commit that landed at or after the target block", async () => {
    const { p } = port({ land: 117 });
    await expect(commitDrill(p, "bob", 12)).rejects.toMatchObject({
      code: "DRILL_COMMIT_TOO_LATE",
    });
  });

  it("times out instead of revealing before finality", async () => {
    const { p } = port({
      heads: async () => ({ best: 200, finalized: 100 }),
    });
    let t = 0;
    await expect(
      revealDrill(
        p,
        {
          commitment: {
            validatorId: "bob",
            committedAtBlock: 106,
            targetBlock: 117,
          },
          commit: { blockHash: hashOf(106), extrinsicIndex: 1 },
        },
        { timeoutMs: 10, sleep: async () => {}, now: () => (t += 20) },
      ),
    ).rejects.toMatchObject({ code: "DRILL_REVEAL_TIMEOUT" });
  });
});
