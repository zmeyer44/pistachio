import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PSEUDO_SPACE_ID,
  credentialCaptureSealAad,
  fromUtf8,
  integrationConnectionSealAad,
  liveProofSealAad,
  recordSealAad,
  runEventSealAad,
  runThreadSealAad,
  shellProofSealAad,
  toHex,
  vaultEntrySealAad,
  workspaceSealAad,
  workspaceSigningBytes,
} from "../src/index.js";

/** Decode a lengthPrefixed() byte string back into its parts. */
function parts(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const len = view.getUint32(offset, false);
    out.push(fromUtf8(bytes.subarray(offset + 4, offset + 4 + len)));
    offset += 4 + len;
  }
  return out;
}

describe("domain-separated AAD layouts (§2, D3)", () => {
  it("uses the pistachio.* domain strings", () => {
    expect(parts(recordSealAad("work", "ab".repeat(32)))).toEqual(["pistachio.sync.seal.v1", "work", "ab".repeat(32)]);
    expect(parts(workspaceSealAad("space:work"))).toEqual(["pistachio.workspace.seal.v1", "space:work"]);
    expect(parts(workspaceSigningBytes("space:work", "c2VhbGVk", { physicalMs: 1, logical: 2, deviceId: "d" }))).toEqual([
      "pistachio.workspacesig.v1",
      "space:work",
      "c2VhbGVk",
      "00000000000001-00000002-d",
    ]);
    expect(parts(workspaceSigningBytes("space:work", null, { physicalMs: 1, logical: 2, deviceId: "d" }))[2]).toBe("");
    expect(parts(runEventSealAad("run-1", "evt-1"))).toEqual(["pistachio.runevent.seal.v1", "run-1", "evt-1"]);
    expect(parts(runThreadSealAad("run-1"))).toEqual(["pistachio.runthread.seal.v1", "run-1"]);
    expect(parts(credentialCaptureSealAad("run-1", "capture-1"))).toEqual([
      "pistachio.credentialcapture.seal.v1",
      "run-1",
      "capture-1",
    ]);
    expect(parts(liveProofSealAad("run-1", "nonce-1"))).toEqual(["pistachio.liveproof.seal.v1", "run-1", "nonce-1"]);
    expect(parts(shellProofSealAad("session-1", "nonce-1"))).toEqual([
      "pistachio.shell.proof.v1",
      "session-1",
      "nonce-1",
    ]);
  });

  it("separates a shell session proof from a live view proof", () => {
    // Both seal a nonce under the same Space key; only the domain keeps a
    // proof for watching a run from standing in as one for driving a session.
    expect(toHex(shellProofSealAad("x", "nonce"))).not.toBe(toHex(liveProofSealAad("x", "nonce")));
    expect(toHex(shellProofSealAad("session", "1nonce"))).not.toBe(toHex(shellProofSealAad("session1", "nonce")));
    expect(toHex(shellProofSealAad("s", "n"))).toBe(toHex(shellProofSealAad("s", "n")));
  });

  it("is deterministic and length-prefixed (no boundary collisions)", () => {
    expect(toHex(recordSealAad("work", "aa"))).toBe(toHex(recordSealAad("work", "aa")));
    expect(toHex(recordSealAad("wor", "kaa"))).not.toBe(toHex(recordSealAad("work", "aa")));
    expect(toHex(runEventSealAad("run", "1evt"))).not.toBe(toHex(runEventSealAad("run1", "evt")));
    expect(toHex(credentialCaptureSealAad("run", "1capture"))).not.toBe(toHex(credentialCaptureSealAad("run1", "capture")));
    expect(parts(vaultEntrySealAad("work", "entry-1"))).toEqual(["pistachio.vault.seal.v1", "work", "entry-1"]);
    expect(toHex(vaultEntrySealAad("work", "entry-1"))).not.toBe(toHex(credentialCaptureSealAad("work", "entry-1")));
    expect(parts(integrationConnectionSealAad("work", "conn-1"))).toEqual(["pistachio.integration.seal.v1", "work", "conn-1"]);
    expect(toHex(integrationConnectionSealAad("work", "conn-1"))).not.toBe(toHex(vaultEntrySealAad("work", "conn-1")));
  });

  it("reserves the workspace pseudo-space id", () => {
    expect(WORKSPACE_PSEUDO_SPACE_ID).toBe("__workspace__");
  });
});
