/**
 * The modifier keys as the OS has them (src/main/os-keys.ts): the native module's answer is only taken when it is the
 * four keys, each held or not — anything else is no answer, and the desk goes by the key events alone.
 */
import { describe, expect, it } from "vitest";
import { modifierKeysFrom, osModifierKeys } from "../src/main/os-keys";

describe("the OS's modifier keys", () => {
  it("are the four keys, each held or not", () => {
    expect(modifierKeysFrom({ shift: true, control: false, alt: false, meta: true })).toEqual({ shift: true, control: false, alt: false, meta: true });
    // (Whatever else the module says of itself is not the desk's.)
    expect(modifierKeysFrom({ shift: false, control: false, alt: false, meta: false, capsLock: true })).toEqual({ shift: false, control: false, alt: false, meta: false });
  });

  it("are no answer when the module says anything else", () => {
    for (const bad of [null, undefined, 4, "shift", {}, { shift: true }, { shift: 1, control: 0, alt: 0, meta: 0 }]) expect(modifierKeysFrom(bad), JSON.stringify(bad)).toBeNull();
  });

  it("are read afresh each time they are asked for, and a module that throws is no answer", () => {
    let held = false;
    const read = osModifierKeys({ modifiers: () => ({ shift: held, control: false, alt: false, meta: false }) });
    expect(read?.()).toMatchObject({ shift: false });
    held = true;
    expect(read?.()).toMatchObject({ shift: true });
    const broken = osModifierKeys({
      modifiers: () => {
        throw new Error("gone");
      },
    });
    expect(broken?.()).toBeNull();
  });

  it("have no reader where there is no module", () => {
    expect(osModifierKeys(null)).toBeNull();
  });
});
