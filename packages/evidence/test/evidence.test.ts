import { describe, expect, it } from "vitest";
import { EvidenceChain, verifyEvidenceEntries } from "../src/index.js";

describe("evidence chain", () => {
  it("hash-chains entries and verifies the result", () => {
    const chain = new EvidenceChain("run-1", {
      principal: "agent-1",
      sponsor: "user-1",
      task: "task-1",
    });
    const first = chain.append("run.started", { purpose: "reconcile" }, "2026-08-24T12:00:00Z");
    const second = chain.append("policy.decision", { outcome: "allow" }, "2026-08-24T12:00:01Z");
    expect(second.previousHash).toBe(first.hash);
    expect(first.signer.algorithm).toBe("Ed25519");
    expect(first.signature.length).toBeGreaterThan(80);
    expect(chain.verify()).toBe(true);
    expect(chain.rootHash()).toHaveLength(64);

    const tampered = chain.entries();
    tampered[0]!.payload = { purpose: "send every invoice" };
    expect(verifyEvidenceEntries(tampered)).toBe(false);
    tampered[0]!.signer.keyId = "0".repeat(64);
    expect(chain.verify()).toBe(true);
  });

  it("rejects sequence, run, signer, and externally anchored truncation inconsistencies", () => {
    const chain = new EvidenceChain("run-1", {
      principal: "agent-1",
      sponsor: "user-1",
      task: "task-1",
    });
    chain.append("run.started", {});
    chain.append("run.completed", {});
    const entries = chain.entries();
    const anchor = {
      expectedRootHash: chain.rootHash(),
      expectedLength: entries.length,
      expectedRunId: "run-1",
      expectedSignerKeyId: entries[0]!.signer.keyId,
    };
    expect(verifyEvidenceEntries(entries, anchor)).toBe(true);
    expect(verifyEvidenceEntries(entries.slice(0, 1), anchor)).toBe(false);

    const badSequence = structuredClone(entries);
    badSequence[1]!.sequence = 3;
    expect(verifyEvidenceEntries(badSequence)).toBe(false);

    const badRun = structuredClone(entries);
    badRun[1]!.runId = "run-2";
    expect(verifyEvidenceEntries(badRun)).toBe(false);

    const otherChain = new EvidenceChain("run-1", entries[0]!.actor);
    otherChain.append("other", {});
    const badSigner = [entries[0]!, otherChain.entries()[0]!];
    badSigner[1] = { ...badSigner[1]!, sequence: 2, previousHash: entries[0]!.hash };
    expect(verifyEvidenceEntries(badSigner)).toBe(false);
  });
});
