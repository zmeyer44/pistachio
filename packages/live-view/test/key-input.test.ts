/**
 * `keyInput`: what a forwarded key press carries into the cloud page
 * (docs/cloud-sync-design.md §8.5, docs/web-browser-design.md §8).
 */

import { describe, expect, it } from "vitest";
import { keyInput, type LiveKeyEvent } from "../src/index.js";

const NO_MODIFIERS = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

function press(key: string, code: string, overrides: Partial<LiveKeyEvent> = {}): LiveKeyEvent {
  return { key, code, ...NO_MODIFIERS, ...overrides };
}

function keyEvent(input: ReturnType<typeof keyInput>): Record<string, unknown> {
  if (input === null || input.t !== "input") throw new Error("the key produced no input");
  return input.event as unknown as Record<string, unknown>;
}

describe("keyInput", () => {
  it("carries the character of a printable keyDown, and nothing on the keyUp", () => {
    expect(keyEvent(keyInput(press("a", "KeyA"), "keyDown"))).toMatchObject({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
    });
    expect(keyEvent(keyInput(press("a", "KeyA"), "keyUp"))).not.toHaveProperty("text");
  });

  it("carries \\r for Enter and \\t for Tab, so CDP raises a keypress", () => {
    // Without `text` Chromium dispatches no `keypress`, and a form with no
    // submit button never submits — what S4 found on the fixture.
    expect(keyEvent(keyInput(press("Enter", "Enter"), "keyDown"))).toMatchObject({
      key: "Enter",
      text: "\r",
      windowsVirtualKeyCode: 13,
    });
    expect(keyEvent(keyInput(press("Tab", "Tab"), "keyDown"))).toMatchObject({
      key: "Tab",
      text: "\t",
      windowsVirtualKeyCode: 9,
    });
    expect(keyEvent(keyInput(press("Enter", "Enter"), "keyUp"))).not.toHaveProperty("text");
  });

  it("leaves text off a command chord and off a key that types nothing", () => {
    expect(keyEvent(keyInput(press("a", "KeyA", { metaKey: true }), "keyDown"))).not.toHaveProperty("text");
    expect(keyEvent(keyInput(press("Enter", "Enter", { ctrlKey: true }), "keyDown"))).not.toHaveProperty("text");
    expect(keyEvent(keyInput(press("ArrowDown", "ArrowDown"), "keyDown"))).not.toHaveProperty("text");
    expect(keyEvent(keyInput(press("Shift", "ShiftLeft"), "keyDown"))).not.toHaveProperty("text");
  });

  it("refuses a key with no name at all", () => {
    expect(keyInput(press("", ""), "keyDown")).toBeNull();
  });
});

describe("physical punctuation codes", () => {
  it.each([[".", "Period", 190], [",", "Comma", 188], ["!", "Digit1", 49], ["?", "Slash", 191]] as const)("forwards %s as text without turning it into a navigation key", (key, code, virtualCode) => {
    expect(keyEvent(keyInput(press(key, code), "keyDown"))).toMatchObject({ text: key, windowsVirtualKeyCode: virtualCode });
  });
});
