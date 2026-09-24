/**
 * The offline queue holds sealed records for one account. Sign-out deletes the
 * file, but the engine can still be draining when that happens: a write that
 * lands afterwards must not bring the signed-out account's queue back.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CookieRecordWire } from "@pistachio/sync-protocol";
import { FileQueueStorage } from "../src/main/sync/queue-file";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pistachio-queue-"));
  dirs.push(dir);
  return join(dir, "work.queue.json");
}

const record = (recordId: string): CookieRecordWire =>
  ({
    spaceId: "work",
    recordId,
    originId: "origin",
    sealedRecord: "sealed",
    hlc: { physicalMs: 1, logical: 0, deviceId: "mac-a" },
    causalParent: null,
    cause: "WRITE",
    deviceSig: "sig",
  }) as unknown as CookieRecordWire;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

describe("the offline queue file", () => {
  it("writes what the engine appends", async () => {
    const path = scratch();
    const storage = new FileQueueStorage(path);
    storage.append("offline", record("r1"));
    await settle();
    expect(existsSync(path)).toBe(true);
  });

  it("never comes back after sign-out removed it", async () => {
    const path = scratch();
    const storage = new FileQueueStorage(path);
    storage.append("offline", record("r1"));
    await settle();
    expect(existsSync(path)).toBe(true);

    storage.remove();
    expect(existsSync(path)).toBe(false);

    // The engine was mid-drain when sign-out landed. Re-arming the debounced
    // write here would recreate the signed-out account's queue on disk.
    storage.append("offline", record("r2"));
    storage.append("deferred", record("r3"));
    await settle();
    expect(existsSync(path)).toBe(false);

    // A flush at quit must not resurrect it either.
    storage.flush();
    expect(existsSync(path)).toBe(false);
  });
});
