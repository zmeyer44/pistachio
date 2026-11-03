import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import { appHolder, bindingOfManifestKey, keyBindings } from "../src/main/extensions/keys";

describe("a manifest's key, in the app's form", () => {
  it("maps Cmd and Ctrl to Mod, the arrows to their names, and keeps the order the app writes", () => {
    expect(bindingOfManifestKey("Cmd+Shift+6")).toBe("Mod+Shift+6");
    expect(bindingOfManifestKey("Shift+Cmd+6")).toBe("Mod+Shift+6");
    expect(bindingOfManifestKey("Ctrl+Alt+R")).toBe("Mod+Alt+R");
    expect(bindingOfManifestKey("Alt+Up")).toBe("Alt+ArrowUp");
    expect(bindingOfManifestKey("Cmd+.")).toBe("Mod+Period");
    expect(bindingOfManifestKey("Cmd+F5")).toBe("Mod+F5");
  });

  it("answers null for a key no binding of the app's can hold", () => {
    expect(bindingOfManifestKey("Cmd+Escape")).toBeNull();
    expect(bindingOfManifestKey("Cmd+Tab")).toBeNull();
    expect(bindingOfManifestKey("Shift+A")).toBeNull();
    expect(bindingOfManifestKey("Cmd+`")).toBeNull();
  });
});

describe("binding the declared keys", () => {
  const recorder = { id: "com.pistachio.recorder", name: "Recorder", commands: [{ id: "toggle", title: "Start or stop recording", key: "Cmd+Shift+6" }] };

  it("binds a free key", () => {
    expect(keyBindings([recorder], DEFAULT_SHORTCUTS)).toEqual([{ extensionId: "com.pistachio.recorder", commandId: "toggle", key: "Cmd+Shift+6", binding: "Mod+Shift+6", unbound: null }]);
  });

  it("leaves a key the app holds unbound, and says what holds it", () => {
    const bindings = keyBindings(
      [
        {
          id: "dev.a",
          name: "A",
          commands: [
            { id: "tab", title: "Steal ⌘T", key: "Cmd+T" },
            { id: "copy", title: "Steal ⌘C", key: "Cmd+C" },
            { id: "devtools", title: "Steal ⌥⌘I", key: "Cmd+Alt+I" },
            { id: "none", title: "No key" },
          ],
        },
      ],
      DEFAULT_SHORTCUTS,
    );
    expect(bindings.map((binding) => binding.binding)).toEqual([null, null, null, null]);
    expect(bindings[0]!.unbound).toContain("Pistachio's New tab");
    expect(bindings[1]!.unbound).toContain("editing or the Mac");
    expect(bindings[2]!.unbound).toContain("developer tools");
    expect(bindings[3]!.unbound).toBeNull();
  });

  it("follows the person's shortcuts: a key they gave an action is the action's", () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, tidyTabs: "Mod+Shift+6" };
    const [binding] = keyBindings([recorder], shortcuts);
    expect(binding).toMatchObject({ binding: null });
    expect(binding!.unbound).toContain("Tidy");
    expect(appHolder("Mod+Shift+6", DEFAULT_SHORTCUTS)).toBeNull();
  });

  it("gives a key two extensions declare to the one first in the person's order", () => {
    const other = { id: "dev.other", name: "Other recorder", commands: [{ id: "go", title: "Go", key: "Cmd+Shift+6" }] };
    const bindings = keyBindings([recorder, other], DEFAULT_SHORTCUTS);
    expect(bindings[0]).toMatchObject({ extensionId: "com.pistachio.recorder", binding: "Mod+Shift+6" });
    expect(bindings[1]).toMatchObject({ extensionId: "dev.other", binding: null });
    expect(bindings[1]!.unbound).toContain("Recorder");
  });

  it("says why a key it cannot bind is left out", () => {
    const [binding] = keyBindings([{ id: "dev.a", name: "A", commands: [{ id: "x", title: "X", key: "Cmd+Escape" }] }], DEFAULT_SHORTCUTS);
    expect(binding).toMatchObject({ binding: null });
    expect(binding!.unbound).toContain("not a key Pistachio can bind");
  });
});
