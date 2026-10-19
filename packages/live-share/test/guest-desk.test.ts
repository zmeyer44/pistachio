import { describe, expect, it, vi } from "vitest";
import type { LiveDeskFrame } from "../src/index.js";
import type { LiveBackground, LiveImageBackground } from "../src/effects.js";
import { GuestDesk, GuestMediaMemory, joinRoom, MediaSwitches, readBackground, restoreMedia, type BackgroundOffer, type GuestMediaPrefs, type JoinedRoom, type RestoredRoom } from "../src/react/index.js";

const frame = (seq: number): LiveDeskFrame => ({ v: 1, seq, stage: { w: 1440, h: 900 }, hostPresent: true, space: { title: "S", color: "#46A758" }, windows: [] });

describe("GuestDesk", () => {
  it("shows a frame only when it is newer, a sync's desk included", () => {
    const desk = new GuestDesk();
    expect(desk.take(frame(1))).toBe(true);
    // The host drags a window as this guest joins: frames 2 and 3 arrive as packets, the sync of frame 1 after them.
    expect(desk.take(frame(2))).toBe(true);
    expect(desk.take(frame(3))).toBe(true);
    expect(desk.take(frame(1))).toBe(false);
    expect(desk.take(frame(3))).toBe(false);
    expect(desk.take(frame(4))).toBe(true);
  });

  it("keeps a frame's number across the host leaving and coming back: main counts per share", () => {
    const desk = new GuestDesk();
    desk.take(frame(40));
    // The host app's room dropped and joined again; main's frames go on from 41, and a stale 39 is still stale.
    expect(desk.take(frame(39))).toBe(false);
    expect(desk.take(frame(41))).toBe(true);
  });

  it("keeps grants heard after the hello over the sync's older word", () => {
    const desk = new GuestDesk();
    desk.asked();
    // While the sync is on its way: Bo took tab-1, then tab-2 was let go.
    desk.grant({ w: "tab-1", user: "g_bo" });
    desk.grant({ w: "tab-2", user: null });
    // The host took the sync before either.
    const grants = desk.synced([
      { w: "tab-1", user: "g_ana" },
      { w: "tab-2", user: "g_ana" },
      { w: "tab-3", user: "g_cy" },
    ]);
    expect([...grants]).toEqual([
      ["tab-1", "g_bo"],
      ["tab-3", "g_cy"],
    ]);
    // Asked afresh (back from a reconnect): what was heard before is the sync's to know, and grants from then on stay over it.
    desk.asked();
    desk.grant({ w: "tab-4", user: "g_bo" });
    expect([...desk.synced([{ w: "tab-1", user: "g_ana" }])]).toEqual([
      ["tab-1", "g_ana"],
      ["tab-4", "g_bo"],
    ]);
  });

  it("keeps grants heard since the ask over a second answer to it, its snapshot older than they are", () => {
    // The first answer came slowly enough that the guest said hello again; both answers come.
    const desk = new GuestDesk();
    desk.asked();
    const snapshot = [
      { w: "tab-1", user: "g_ana" },
      { w: "tab-2", user: "g_ana" },
    ];
    desk.synced(snapshot);
    desk.grant({ w: "tab-1", user: "g_bo" });
    desk.grant({ w: "tab-2", user: null });
    expect([...desk.synced(snapshot)]).toEqual([["tab-1", "g_bo"]]);
  });

  it("counts grants heard before the first sync as newer, hello or not (the host sends one as the guest joins)", () => {
    const desk = new GuestDesk();
    desk.grant({ w: "tab-1", user: "g_bo" });
    expect([...desk.synced([])]).toEqual([["tab-1", "g_bo"]]);
  });
});

describe("joinRoom", () => {
  function room(ends: () => ReturnType<JoinedRoom["endReason"]> = () => null) {
    return { endReason: vi.fn(ends), disconnect: vi.fn(async () => undefined) };
  }

  it("joins, putting the camera back after a reload", async () => {
    const joined = room();
    const restore = vi.fn(async () => undefined);
    expect(await joinRoom({ connect: async () => joined, restore, cancelled: () => false })).toEqual({ kind: "joined", room: joined });
    expect(restore).toHaveBeenCalledWith(joined);
  });

  it("says the room ended when it ended while the camera came back, though nobody listened then", async () => {
    let ended = false;
    const joined = room(() => (ended ? "ended" : null));
    const outcome = await joinRoom({
      connect: async () => joined,
      restore: async () => {
        ended = true; // the host stopped sharing during the permission prompt
      },
      cancelled: () => false,
    });
    expect(outcome).toEqual({ kind: "ended", reason: "ended" });
  });

  it("disconnects a room the page stopped wanting, during the connect or the restore", async () => {
    let cancelled = false;
    const late = room();
    expect(await joinRoom({ connect: async () => late, restore: async () => void (cancelled = true), cancelled: () => cancelled })).toEqual({ kind: "cancelled" });
    expect(late.disconnect).toHaveBeenCalled();
    const early = room();
    const restore = vi.fn(async () => undefined);
    expect(await joinRoom({ connect: async () => early, restore, cancelled: () => true })).toEqual({ kind: "cancelled" });
    expect(restore).not.toHaveBeenCalled();
    expect(early.disconnect).toHaveBeenCalled();
  });

  it("keeps the room when putting the camera back fails", async () => {
    const joined = room();
    const outcome = await joinRoom({ connect: async () => joined, restore: async () => Promise.reject(new Error("NotAllowedError")), cancelled: () => false });
    expect(outcome).toEqual({ kind: "joined", room: joined });
  });
});

describe("restoreMedia", () => {
  const scenes: LiveImageBackground[] = [
    { kind: "image", label: "Dusk", url: "data:image/svg+xml,dusk" },
    { kind: "image", label: "Lagoon", url: "data:image/svg+xml,lagoon" },
  ];
  const offer: BackgroundOffer = { scenes, supported: true };
  const prefs = (changes: Partial<GuestMediaPrefs> = {}): GuestMediaPrefs => ({ microphone: false, camera: true, audioinput: null, videoinput: null, audiooutput: null, background: { kind: "none" }, ...changes });

  /** A page as it starts after a reload: what the last one saved, through storage as the guest page keeps it. */
  function reloaded(saved: GuestMediaPrefs, start: BackgroundOffer = offer): GuestMediaMemory {
    const stored = JSON.parse(JSON.stringify(saved)) as GuestMediaPrefs;
    return new GuestMediaMemory({ ...stored, background: readBackground(stored.background) }, () => undefined, start);
  }

  /** The prefs a page saved last, once `choose` has run on it. */
  function chosen(before: GuestMediaPrefs, choose: (memory: GuestMediaMemory) => void): GuestMediaPrefs {
    let saved = before;
    choose(new GuestMediaMemory(before, (prefs) => (saved = prefs), offer));
    return saved;
  }

  /**
   * A room whose devices named in `gone` are unplugged, whose `failing` kinds find no device at all, and whose
   * `blocked` ones the browser refuses; with `backgroundFails`, a camera behind any background is kept out (the
   * room stops it and rejects, as when the segmenter did not load).
   */
  function room(gone: string[], failing: string[] = [], blocked: string[] = [], backgroundFails = false) {
    const calls: string[] = [];
    let behind: LiveBackground = { kind: "none" };
    const turn = async (kind: string, deviceId?: string): Promise<void> => {
      calls.push(`${kind} ${deviceId ?? "default"}`);
      if (blocked.includes(kind)) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      if (failing.includes(kind) || (deviceId !== undefined && gone.includes(deviceId))) throw Object.assign(new Error("no such device"), { name: "OverconstrainedError" });
      if (kind === "camera" && backgroundFails && behind.kind !== "none") throw new Error("the segmenter did not load");
    };
    const restored: RestoredRoom = {
      setBackground: async (background) => {
        behind = background;
        calls.push(`background ${background.kind === "image" ? (background.label ?? background.url) : background.kind}`);
        return true;
      },
      setMicrophone: (_on, deviceId) => turn("microphone", deviceId),
      setCamera: (_on, deviceId) => turn("camera", deviceId),
    };
    return { restored, calls };
  }

  it("puts the background on first, then the microphone and camera on their devices, the default for one that is gone, as the lobby does", async () => {
    const { restored, calls } = room(["mic-gone"]);
    const memory = reloaded(prefs({ microphone: true, camera: true, audioinput: "mic-gone", videoinput: "cam-2", audiooutput: "speaker-2", background: { kind: "blur" } }));
    expect(await restoreMedia(restored, memory)).toBeNull();
    expect(calls).toEqual(["background blur", "microphone mic-gone", "microphone default", "camera cam-2"]);
  });

  it("remembers the default in place of a device gone once it came on there, so the menu names it and off and on again asks for it", async () => {
    const { restored, calls } = room(["mic-gone", "cam-gone"]);
    const saved: GuestMediaPrefs[] = [];
    const memory = new GuestMediaMemory(prefs({ microphone: true, audioinput: "mic-gone", videoinput: "cam-gone", audiooutput: "speaker-2" }), (each) => saved.push(each), offer);
    expect(await restoreMedia(restored, memory)).toBeNull();
    expect(calls.splice(0)).toEqual(["microphone mic-gone", "microphone default", "camera cam-gone", "camera default"]);
    expect(memory.current()).toMatchObject({ microphone: true, camera: true, audioinput: null, videoinput: null, audiooutput: "speaker-2" });
    expect(saved.at(-1)).toMatchObject({ audioinput: null, videoinput: null });
    // The room's switch, off and on again: the default comes on, not the device gone.
    const switches = new MediaSwitches(restored);
    expect(await memory.switch(switches.set, "camera", false)).toBe("done");
    expect(await memory.switch(switches.set, "camera", true)).toBe("done");
    expect(calls).toEqual(["camera default", "camera default"]);
  });

  it("tries the default only for a device that is gone, not one the browser refused or that would not start", async () => {
    const { restored, calls } = room([], [], ["microphone"]);
    await restoreMedia(restored, reloaded(prefs({ microphone: true, camera: false, audioinput: "mic-2" })));
    expect(calls).toEqual(["microphone mic-2"]);
  });

  it("leaves off what was off, and gives up quietly when the default fails too", async () => {
    const { restored, calls } = room([], ["camera"]);
    expect(await restoreMedia(restored, reloaded(prefs({ videoinput: "cam-2" })))).toBeNull();
    expect(calls).toEqual(["camera cam-2", "camera default"]);
  });

  it("brings the camera back behind the background chosen before the reload — blur, a scene — never without it", async () => {
    // Chosen in the room (or the lobby), then the page reloaded while the guest was admitted.
    const blurred = chosen(prefs({ microphone: true }), (memory) => memory.chooseBackground({ kind: "blur", strength: "strong" }));
    const first = room([]);
    expect(await restoreMedia(first.restored, reloaded(blurred))).toBeNull();
    expect(first.calls).toEqual(["background blur", "microphone default", "camera default"]);

    const dusk = chosen(prefs(), (memory) => memory.chooseBackground(scenes[0]!));
    expect(dusk.background).toEqual({ kind: "scene", name: "Dusk" });
    const second = room([]);
    const memory = reloaded(dusk);
    // The menus name it too.
    expect(memory.background()).toBe(scenes[0]);
    await restoreMedia(second.restored, memory);
    expect(second.calls).toEqual(["background Dusk", "camera default"]);
  });

  it("keeps the camera off after a reload when the guest's own picture was behind it, and says why, until they answer it", async () => {
    const saved = chosen(prefs({ microphone: true }), (memory) => memory.chooseBackground({ kind: "image", url: "blob:https://www.pistachio.run/1f2e", label: "Your picture" }));
    // Only that it was a picture of their own: the picture is not kept.
    expect(saved.background).toEqual({ kind: "picture" });
    expect(JSON.stringify(saved)).not.toContain("blob:");

    const { restored, calls } = room([]);
    const memory = reloaded(saved);
    expect(memory.background()).toEqual({ kind: "none" });
    expect(memory.held()).toBe("not-kept");
    expect(await restoreMedia(restored, memory)).toBe("not-kept");
    expect(calls).toEqual(["microphone default"]);

    // A background chosen again answers it; so does the camera turned on as it now is.
    memory.chooseBackground({ kind: "blur" });
    expect(memory.held()).toBeNull();
    const again = reloaded(saved);
    again.remember({ camera: true });
    expect(again.held()).toBeNull();
    // Rejoined later on the same page (the room lost): the camera comes back behind the choice made since.
    const later = room([]);
    expect(await restoreMedia(later.restored, memory)).toBeNull();
    expect(later.calls).toEqual(["background blur", "microphone default", "camera default"]);
  });

  it("keeps the camera off where this browser cannot run the background remembered, and says why", async () => {
    const { restored, calls } = room([]);
    const memory = reloaded(prefs({ background: { kind: "blur" } }), { scenes, supported: false });
    expect(memory.background()).toEqual({ kind: "none" });
    expect(await restoreMedia(restored, memory)).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  it("says the background did not load when the room keeps the camera out for it, and nothing for a camera failing on its own", async () => {
    const segmenter = room([], [], [], true);
    expect(await restoreMedia(segmenter.restored, reloaded(prefs({ background: { kind: "blur" } })))).toBe("failed");
    expect(segmenter.calls).toEqual(["background blur", "camera default"]);
    const refused = room([], [], ["camera"]);
    expect(await restoreMedia(refused.restored, reloaded(prefs({ background: { kind: "blur" } })))).toBeNull();
    expect(refused.calls).toEqual(["background blur", "camera default"]);
  });
});
