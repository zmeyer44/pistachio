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
  shortcutActionForEvent,
  shortcutAccelerator,
  shortcutConflict,
  shortcutFromEvent,
  shortcutLabel,
} from "../src/shortcuts.js";

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

  it("reports conflicts and protects editing/OS bindings", () => {
    expect(shortcutConflict(DEFAULT_SHORTCUTS, "Mod+T", "editAddress")?.id).toBe("newTab");
    expect(reservedShortcutReason("Mod+C")).not.toBeNull();
    expect(reservedShortcutReason("Mod+Shift+K")).toBeNull();
  });
});
