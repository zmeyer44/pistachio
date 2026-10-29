import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveMediaDevice } from "@pistachio/shell-contracts/live-share";
import { DEFAULT_LIVE_SHARE_PREFS, deviceToKeep, livePrefsFile, restoredDevices, sanitizeLiveSharePrefs, startingChoices, type LiveSharePrefs } from "../src/main/live/live-prefs";

const KEPT: LiveSharePrefs = {
  admission: "open",
  guestsCanDraw: false,
  mic: true,
  camera: true,
  background: { kind: "blur", strength: "light" },
  devices: { audioinput: { deviceId: "mic-1", label: "MacBook Pro Microphone" }, videoinput: { deviceId: "cam-1", label: "Studio Display Camera" }, audiooutput: null },
};

const devices = (...list: Array<[LiveMediaDevice["kind"], string, string]>): LiveMediaDevice[] => list.map(([kind, deviceId, label]) => ({ kind, deviceId, label }));

describe("the host's kept sharing choices", () => {
  it("read back as written, and a first share's when there is nothing", () => {
    expect(sanitizeLiveSharePrefs(JSON.parse(JSON.stringify(KEPT)))).toEqual(KEPT);
    expect(sanitizeLiveSharePrefs(null)).toEqual(DEFAULT_LIVE_SHARE_PREFS);
    expect(sanitizeLiveSharePrefs("nonsense")).toEqual(DEFAULT_LIVE_SHARE_PREFS);
  });

  it("keep each choice that reads, and give a first share's for one that does not", () => {
    const read = sanitizeLiveSharePrefs({
      admission: "everyone",
      guestsCanDraw: false,
      mic: "yes",
      camera: true,
      background: { kind: "image", url: "javascript:alert(1)" },
      devices: { audioinput: { deviceId: "mic-1", label: "Mic" }, videoinput: { deviceId: "" , label: "x" }, audiooutput: 7 },
    });
    expect(read).toEqual({
      admission: "ask",
      guestsCanDraw: false,
      mic: false,
      camera: true,
      background: { kind: "none" },
      devices: { audioinput: { deviceId: "mic-1", label: "Mic" }, videoinput: null, audiooutput: null },
    });
  });

  it("start a share with them, on the system's default devices until the host app lists its own", () => {
    expect(startingChoices(KEPT)).toEqual({
      admission: "open",
      guestsCanDraw: false,
      local: { mic: true, camera: true, background: { kind: "blur", strength: "light" }, devices: { audioinput: null, videoinput: null, audiooutput: null } },
    });
  });

  it("keep a picked device with its label off the app's list, or the kept one's for the same device", () => {
    const listed = devices(["audioinput", "mic-2", "AirPods Pro"]);
    expect(deviceToKeep(listed, null, "audioinput", "mic-2")).toEqual({ deviceId: "mic-2", label: "AirPods Pro" });
    expect(deviceToKeep([], { deviceId: "mic-2", label: "AirPods Pro" }, "audioinput", "mic-2")).toEqual({ deviceId: "mic-2", label: "AirPods Pro" });
    expect(deviceToKeep([], { deviceId: "mic-1", label: "Old" }, "audioinput", "mic-2")).toEqual({ deviceId: "mic-2", label: "" });
    expect(deviceToKeep(listed, { deviceId: "mic-2", label: "AirPods Pro" }, "audioinput", null)).toBeNull();
  });

  it("find a kept device among those listed by its id, else by its label (another session's id), else not at all", () => {
    const all = new Set(["audioinput", "videoinput", "audiooutput"] as const);
    // The same ids: taken up as they are.
    expect(restoredDevices(KEPT, devices(["audioinput", "mic-1", "MacBook Pro Microphone"], ["videoinput", "cam-1", "Studio Display Camera"]), all)).toEqual({ audioinput: "mic-1", videoinput: "cam-1" });
    // New ids this session: found by label.
    expect(restoredDevices(KEPT, devices(["audioinput", "mic-9", "MacBook Pro Microphone"], ["videoinput", "cam-9", "Studio Display Camera"]), all)).toEqual({ audioinput: "mic-9", videoinput: "cam-9" });
    // The camera unplugged: the share stays on the default one; nothing taken up for a kind not waiting.
    expect(restoredDevices(KEPT, devices(["audioinput", "mic-1", "MacBook Pro Microphone"], ["videoinput", "cam-7", "FaceTime HD Camera"]), all)).toEqual({ audioinput: "mic-1" });
    expect(restoredDevices(KEPT, devices(["audioinput", "mic-1", "MacBook Pro Microphone"]), new Set(["videoinput"] as const))).toEqual({});
  });

  it("never find a device by an empty label (a list from before the host may use the mic and camera names none)", () => {
    const unnamed: LiveSharePrefs = { ...KEPT, devices: { ...KEPT.devices, audioinput: { deviceId: "mic-1", label: "" } } };
    expect(restoredDevices(unnamed, devices(["audioinput", "x", ""]), new Set(["audioinput"] as const))).toEqual({});
  });
});

describe("the kept choices' file", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("is written whole and read back; a torn or missing one reads as a first share's", () => {
    dir = mkdtempSync(join(tmpdir(), "pistachio-live-prefs-"));
    const file = livePrefsFile(dir);
    expect(file.read()).toEqual(DEFAULT_LIVE_SHARE_PREFS);
    file.write(KEPT);
    expect(JSON.parse(readFileSync(join(dir, "live-share.json"), "utf8"))).toEqual(KEPT);
    expect(file.read()).toEqual(KEPT);
    writeFileSync(join(dir, "live-share.json"), "{ torn");
    expect(file.read()).toEqual(DEFAULT_LIVE_SHARE_PREFS);
  });
});
