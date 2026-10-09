import { describe, expect, it } from "vitest";
import {
  appearanceGradient,
  colorsForHarmony,
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
} from "../src/appearance.js";
import {
  DEFAULT_SHORTCUTS,
  reservedShortcutReason,
  sanitizeShortcuts,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_DEFINITIONS,
  shortcutOffered,
  shortcutActionForEvent,
  shortcutAccelerator,
  shortcutConflict,
  shortcutFromEvent,
  shortcutLabel,
  shortcutsGivingUp,
  shortcutsMeet,
} from "../src/shortcuts.js";
import { applySettingsPatch, DEFAULT_SETTINGS } from "../src/settings.js";

describe("appearance customization", () => {
  it("accepts up to three colors and clamps material values", () => {
    expect(
      sanitizeAppearance({
        scheme: "dark",
        desktopGlass: false,
        glassTint: 0.01,
        colors: ["#abc", "#123456", "bad", "#ffffff", "#000000"],
        angle: 720,
        intensity: -1,
        texture: 2,
        surfaceOpacity: 0.1,
        radius: 99,
      }),
    ).toMatchObject({
      scheme: "dark",
      desktopGlass: false,
      glassTint: 0.25,
      colors: ["#AABBCC", "#123456", "#FFFFFF"],
      angle: 359,
      intensity: 0,
      texture: 1,
      surfaceOpacity: 0.55,
      radius: 18,
    });
    expect(sanitizeAppearance({ glassTint: 2 }).glassTint).toBe(1);
  });

  it("keeps a toast position it knows, and falls back to the foot for one it does not", () => {
    expect(sanitizeAppearance({}).toastPosition).toBe("bottom");
    expect(sanitizeAppearance({ toastPosition: "top-right" }).toastPosition).toBe("top-right");
    expect(sanitizeAppearance({ toastPosition: "middle" }).toastPosition).toBe("bottom");
    expect(sanitizeAppearance({ toastPosition: 3 }, { ...sanitizeAppearance({}), toastPosition: "top" }).toastPosition).toBe("top");
  });

  it("generates the two/three-dot harmony shapes", () => {
    expect(colorsForHarmony("#88C999", "complementary")).toHaveLength(2);
    expect(colorsForHarmony("#88C999", "singleAnalogous")).toHaveLength(2);
    expect(colorsForHarmony("#88C999", "splitComplementary")).toHaveLength(3);
    expect(colorsForHarmony("#88C999", "analogous")).toHaveLength(3);
    expect(colorsForHarmony("#88C999", "triadic")).toHaveLength(3);
    expect(colorsForHarmony("#123456", "floating", ["#ABCDEF", "#000000", "#FFFFFF"])).toEqual([
      "#123456",
      "#000000",
      "#FFFFFF",
    ]);
  });

  it("builds each paint mode and can turn the material off", () => {
    expect(appearanceGradient({ ...DEFAULT_APPEARANCE, blend: "mesh" })).toContain("radial-gradient");
    expect(appearanceGradient({ ...DEFAULT_APPEARANCE, blend: "linear" })).toMatch(/^linear-gradient/);
    expect(appearanceGradient({ ...DEFAULT_APPEARANCE, blend: "radial" })).not.toContain("linear-gradient");
    expect(appearanceGradient({ ...DEFAULT_APPEARANCE, gradientEnabled: false })).toBe("none");
  });

  it("keeps the glass gradient lighter than the solid window paint", () => {
    expect(appearanceGradient(DEFAULT_APPEARANCE, 0.25)).not.toBe(appearanceGradient(DEFAULT_APPEARANCE));
  });
});

describe("editable shortcuts", () => {
  it("normalizes DOM and Electron key events into the same portable binding", () => {
    expect(shortcutFromEvent({ key: "k", metaKey: true }, "darwin")).toBe("Mod+K");
    expect(shortcutFromEvent({ key: "K", meta: true, shift: true }, "darwin")).toBe("Mod+Shift+K");
    expect(shortcutFromEvent({ key: "k", control: true }, "other")).toBe("Mod+K");
    expect(shortcutFromEvent({ key: "k" }, "darwin")).toBeNull();
    expect(shortcutFromEvent({ key: "F8" }, "darwin")).toBe("F8");
  });

  it("matches, labels, and converts the persisted form", () => {
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "t", meta: true }, "darwin")).toBe("newTab");
    expect(shortcutLabel("Mod+Shift+K", "darwin")).toBe("⌘⇧K");
    expect(shortcutLabel("Mod+Shift+K", "other")).toBe("Ctrl+Shift+K");
    expect(shortcutAccelerator("Mod+Shift+K")).toBe("CommandOrControl+Shift+K");
  });

  it("copies the page URL on the Arc bindings, reading the physical key under Option", () => {
    expect(DEFAULT_SHORTCUTS.copyUrl).toBe("Mod+Shift+C");
    expect(DEFAULT_SHORTCUTS.copyUrlMarkdown).toBe("Mod+Alt+Shift+C");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "C", code: "KeyC", meta: true, shift: true }, "darwin")).toBe("copyUrl");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }, "other")).toBe("copyUrl");
    // macOS composes ⌥⇧C into "Ç": the binding still matches on the key itself.
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "Ç", code: "KeyC", meta: true, alt: true, shift: true }, "darwin")).toBe(
      "copyUrlMarkdown",
    );
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "C", code: "KeyC", ctrlKey: true, altKey: true, shiftKey: true }, "other")).toBe(
      "copyUrlMarkdown",
    );
    // Without Option the character rules, so a layout's own keys keep working.
    expect(shortcutFromEvent({ key: "t", code: "KeyY", meta: true }, "darwin")).toBe("Mod+T");
    expect(shortcutLabel("Mod+Alt+Shift+C", "darwin")).toBe("⌘⌥⇧C");
    expect(shortcutAccelerator("Mod+Alt+Shift+C")).toBe("CommandOrControl+Alt+Shift+C");
  });

  it("takes screenshots on ⌘⇧1 and ⌘⇧2, read from the digit under Shift", () => {
    expect(DEFAULT_SHORTCUTS.screenshotView).toBe("Mod+Shift+1");
    expect(DEFAULT_SHORTCUTS.screenshotArea).toBe("Mod+Shift+2");
    // Shift turns the digit into its symbol ("!" on a US keyboard, "&" on a French one): the key is the binding.
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "!", code: "Digit1", meta: true, shift: true }, "darwin")).toBe("screenshotView");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "@", code: "Digit2", metaKey: true, shiftKey: true }, "darwin")).toBe("screenshotArea");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "@", code: "Digit2", ctrlKey: true, shiftKey: true }, "other")).toBe("screenshotArea");
    expect(shortcutLabel("Mod+Shift+1", "darwin")).toBe("⌘⇧1");
    expect(shortcutAccelerator("Mod+Shift+2")).toBe("CommandOrControl+Shift+2");
  });

  it("binds the familiar reopen-closed-tab key, and yields it to an older custom binding", () => {
    expect(DEFAULT_SHORTCUTS.restoreClosedTab).toBe("Mod+Shift+T");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, { key: "T", code: "KeyT", meta: true, shift: true }, "darwin")).toBe("restoreClosedTab");
    // A settings file from before the action existed has no entry for it;
    // the default fills in, unless the person already gave that key away.
    const { restoreClosedTab: _omitted, ...older } = DEFAULT_SHORTCUTS;
    expect(sanitizeShortcuts(older).restoreClosedTab).toBe("Mod+Shift+T");
    expect(sanitizeShortcuts({ ...older, readerView: "Mod+Shift+T" })).toMatchObject({ readerView: "Mod+Shift+T", restoreClosedTab: null });
  });

  it("keeps disabled bindings and removes duplicates from an edited file", () => {
    const next = sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, newTab: null, editAddress: "Mod+W" });
    expect(next.newTab).toBeNull();
    expect(next.editAddress).toBe("Mod+W");
    // Definitions are sanitized in a stable order: editAddress appears before
    // closeTab, so the later duplicate cannot shadow it.
    expect(next.closeTab).toBeNull();
    expect(Object.values(next).filter((binding) => binding === "Mod+W")).toHaveLength(1);
  });

  it("keeps a retired action's id but never a key for it, so the key it held is free", () => {
    const toggleDesk = SHORTCUT_DEFINITIONS.find((definition) => definition.id === "toggleDesk")!;
    expect(SHORTCUT_ACTION_IDS).toContain("toggleDesk");
    expect(DEFAULT_SHORTCUTS.toggleDesk).toBeNull();
    // Every file written before 2026-10-09 saved ⌥⌘\ for it: the key is free for another action now.
    expect(sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, toggleDesk: "Mod+Alt+Backslash" }).toggleDesk).toBeNull();
    expect(sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, toggleDesk: "Mod+Alt+Backslash", openNotes: "Mod+Alt+Backslash" }).openNotes).toBe("Mod+Alt+Backslash");
    expect(shortcutOffered(toggleDesk, "native")).toBe(false);
    expect(shortcutOffered(toggleDesk, "stream")).toBe(false);
  });

  it("offers each action on its own surfaces: the desk's on the Mac, splits on the web, the rest on both", () => {
    const offered = (id: string) => {
      const definition = SHORTCUT_DEFINITIONS.find((candidate) => candidate.id === id)!;
      return [shortcutOffered(definition, "native"), shortcutOffered(definition, "stream")];
    };
    expect(offered("tileDesk")).toEqual([true, false]);
    expect(offered("cascadeDesk")).toEqual([true, false]);
    expect(offered("arrangeDesk")).toEqual([true, false]);
    expect(offered("toggleSplit")).toEqual([false, true]);
    expect(offered("toggleSidebarPinned")).toEqual([true, true]);
    expect(offered("newTab")).toEqual([true, true]);
  });

  // Each surface reads only the actions it offers (2026-10-09): ⌘\ is the web's split's, and no one's on the desktop.
  it("matches a key only to an action the surface offers: the rest go on to the page", () => {
    const backslash = { key: "\\", code: "Backslash", meta: true };
    const tile = { key: "†", code: "KeyT", meta: true, alt: true };
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, backslash, "darwin", "native")).toBeNull();
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, backslash, "darwin", "stream")).toBe("toggleSplit");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, tile, "darwin", "native")).toBe("tileDesk");
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, tile, "darwin", "stream")).toBeNull();
    // Unsaid, every action is matched, as before.
    expect(shortcutActionForEvent(DEFAULT_SHORTCUTS, backslash, "darwin")).toBe("toggleSplit");
    // One key, an action of each surface: each surface's own.
    const shared = sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, tileDesk: "Mod+Backslash" });
    expect(shortcutActionForEvent(shared, backslash, "darwin", "native")).toBe("tileDesk");
    expect(shortcutActionForEvent(shared, backslash, "darwin", "stream")).toBe("toggleSplit");
  });

  it("lets two actions no surface offers both of share a key; one offered on both meets every other", () => {
    expect(shortcutsMeet("toggleSplit", "tileDesk")).toBe(false);
    expect(shortcutsMeet("toggleSplit", "reload")).toBe(true);
    expect(shortcutsMeet("tileDesk", "reload")).toBe(true);
    expect(shortcutsMeet("toggleDesk", "reload")).toBe(false);
    expect(sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, tileDesk: "Mod+Backslash" })).toMatchObject({ toggleSplit: "Mod+Backslash", tileDesk: "Mod+Backslash" });
    // A pair that meets is a duplicate as ever: the later one is unassigned.
    expect(sanitizeShortcuts({ ...DEFAULT_SHORTCUTS, reload: "Mod+Backslash" })).toMatchObject({ reload: "Mod+Backslash", toggleSplit: null });
    // The settings writer agrees.
    expect(applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { tileDesk: "Mod+Backslash" } }).shortcuts).toMatchObject({ toggleSplit: "Mod+Backslash", tileDesk: "Mod+Backslash" });
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { reload: "Mod+Backslash" } })).toThrow(/cannot both use/);
  });

  it("finds no conflict on a surface with an action it does not list: that one gives the key up in the same write, if they meet", () => {
    // Settings › Shortcuts on the desktop: the split holds ⌘\, and is not listed there.
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Backslash", "reload", "native")).toBeNull();
    expect(shortcutsGivingUp(DEFAULT_SHORTCUTS, "Mod+Backslash", "reload", "native")).toEqual(["toggleSplit"]);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { toggleSplit: null, reload: "Mod+Backslash" } }).shortcuts).toMatchObject({ reload: "Mod+Backslash", toggleSplit: null });
    // A desk key never meets the split: it is no one's conflict, and the split keeps its key.
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Backslash", "tileDesk", "native")).toBeNull();
    expect(shortcutsGivingUp(DEFAULT_SHORTCUTS, "Mod+Backslash", "tileDesk", "native")).toEqual([]);
    // Unsaid, the surfaces where they meet count.
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Backslash", "reload")?.id).toBe("toggleSplit");
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Backslash", "tileDesk")).toBeNull();
    // On the web, the desk's keys alike.
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Alt+T", "reload", "stream")).toBeNull();
    expect(shortcutsGivingUp(DEFAULT_SHORTCUTS, "Mod+Alt+T", "reload", "stream")).toEqual(["tileDesk"]);
    // What the surface lists still conflicts.
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+T", "editAddress", "native")?.id).toBe("newTab");
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+Alt+T", "reload", "native")?.id).toBe("tileDesk");
  });

  it("reports conflicts and protects editing/OS bindings", () => {
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+T", "editAddress")?.id).toBe("newTab");
    expect(reservedShortcutReason("Mod+C")).not.toBeNull();
    expect(reservedShortcutReason("Mod+Shift+K")).toBeNull();
  });
});
