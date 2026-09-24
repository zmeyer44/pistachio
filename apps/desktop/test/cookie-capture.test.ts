/**
 * Cookie capture (docs/cloud-sync-design.md §10.2): a Space session's
 * cookies-'changed' burst is serialized into the engine in browser order,
 * exposes a drain fence, and is skipped while the jar is being hydrated or
 * bulk-written.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Cookie, Session } from "electron";
import { attachCookieCapture, type CaptureEngine } from "../src/main/sync/capture";

function cookie(name: string, domain = ".google.com"): Cookie {
  return {
    name,
    value: `${name}-value`,
    domain,
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
  };
}

describe("cookie capture ordering", () => {
  it("serializes a same-response cookie burst and exposes a drain fence", async () => {
    const cookies = new EventEmitter();
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const localChange = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(null);
    const errors: unknown[] = [];
    const capture = attachCookieCapture(
      { cookies } as unknown as Session,
      "space-1",
      { localChange } as unknown as CaptureEngine,
      () => false,
      (error) => errors.push(error),
    );

    cookies.emit("changed", {}, cookie("SID"), "explicit", false);
    cookies.emit("changed", {}, cookie("HSID"), "explicit", false);
    await Promise.resolve();

    // The second Google cookie cannot start another same-origin lease request
    // until the first mutation has finished.
    expect(localChange).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await capture.drain();

    expect(localChange).toHaveBeenCalledTimes(2);
    expect(localChange.mock.calls.map((call) => call[0].name)).toEqual(["SID", "HSID"]);
    // The identity is the protocol's: a domain cookie keeps its leading dot, the Space rides along.
    expect(localChange.mock.calls[0]?.[0]).toMatchObject({ spaceId: "space-1", hostKey: ".google.com", path: "/" });
    expect(localChange.mock.calls[0]?.[1]).toMatchObject({ value: "SID-value", secure: true, httpOnly: true, sameSite: "lax" });
    expect(localChange.mock.calls[0]?.[3]).toBe("explicit");
    expect(errors).toEqual([]);
    capture.detach();
  });

  it("maps a removal to a tombstone change and keeps the queue usable after a failure", async () => {
    const cookies = new EventEmitter();
    const localChange = vi.fn().mockRejectedValueOnce(new Error("sealed elsewhere")).mockResolvedValue(null);
    const errors: unknown[] = [];
    const capture = attachCookieCapture(
      { cookies } as unknown as Session,
      "space-1",
      { localChange } as unknown as CaptureEngine,
      () => false,
      (error) => errors.push(error),
    );
    cookies.emit("changed", {}, cookie("SID"), "explicit", true);
    cookies.emit("changed", {}, cookie("HSID"), "overwrite", false);
    await capture.drain();
    expect(errors).toHaveLength(1);
    expect(localChange).toHaveBeenCalledTimes(2);
    expect(localChange.mock.calls[0]?.slice(1)).toEqual([null, true, "explicit"]);
    expect(localChange.mock.calls[1]?.[2]).toBe(false);
    capture.detach();
  });

  it("skips events while the jar is hydrating or bulk-written, and disabled cookies", async () => {
    const cookies = new EventEmitter();
    const localChange = vi.fn().mockResolvedValue(null);
    let hydrating = true;
    const capture = attachCookieCapture(
      { cookies } as unknown as Session,
      "space-1",
      { localChange } as unknown as CaptureEngine,
      () => hydrating,
      () => undefined,
      (candidate) => candidate.name === "device-local",
    );
    cookies.emit("changed", {}, cookie("SID"), "explicit", false);
    hydrating = false;
    cookies.emit("changed", {}, cookie("device-local"), "explicit", false);
    cookies.emit("changed", {}, cookie("HSID"), "explicit", false);
    await capture.drain();
    expect(localChange.mock.calls.map((call) => call[0].name)).toEqual(["HSID"]);
    capture.detach();
    cookies.emit("changed", {}, cookie("SSID"), "explicit", false);
    await capture.drain();
    expect(localChange).toHaveBeenCalledTimes(1);
  });
});
