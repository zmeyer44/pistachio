/**
 * The split of the bridge into what a host can answer and what only a native
 * window can (docs/web-browser-design.md W6, §3.1). The compiler does most of
 * the work — `satisfies` on the table, the exhaustiveness helpers on the two
 * lists — so these tests guard the parts a type cannot: that every native
 * member carries a reason a reader can check, and that the derived lists and
 * the interface stay one thing.
 */

import { describe, expect, it } from "vitest";
import {
  IPC,
  NATIVE_SURFACE_MEMBERS,
  SHELL_EVENT_CHANNELS,
  SHELL_METHOD_NAMES,
  type NativeSurfaceApi,
  type PistachioApi,
  type ShellApi,
} from "../src/ipc.js";

/** The type-level half of the rule, as §3.1 states it. */
type NativeKeysMatch = keyof NativeSurfaceApi extends keyof typeof NATIVE_SURFACE_MEMBERS
  ? keyof typeof NATIVE_SURFACE_MEMBERS extends keyof NativeSurfaceApi
    ? true
    : false
  : false;
const NATIVE_KEYS_MATCH: NativeKeysMatch = true;

/** ShellApi and NativeSurfaceApi together are still the whole preload bridge. */
type BridgeIsWhole = keyof PistachioApi extends keyof ShellApi | keyof NativeSurfaceApi
  ? keyof ShellApi | keyof NativeSurfaceApi extends keyof PistachioApi
    ? true
    : false
  : false;
const BRIDGE_IS_WHOLE: BridgeIsWhole = true;

describe("NATIVE_SURFACE_MEMBERS", () => {
  it("names exactly the members of NativeSurfaceApi", () => {
    expect(NATIVE_KEYS_MATCH).toBe(true);
    expect(BRIDGE_IS_WHOLE).toBe(true);
  });

  it("gives every member a reason at least ten characters long", () => {
    // Mirrors the chrome manifest's hidden-placement rule: a member may not
    // leave the shared contract without a reason the next reader can weigh.
    for (const [member, reason] of Object.entries(NATIVE_SURFACE_MEMBERS)) {
      expect(reason.length, member).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps the geometry members out of the shared contract", () => {
    // The members W6 names: they exist only to place native views over holes
    // in the DOM, and the web has no such views.
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("setLayout");
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("prepareOverlay");
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("setGlanceBounds");
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("setDragCapture");
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("getCursorPoint");
    expect(NATIVE_SURFACE_MEMBERS).toHaveProperty("setMediaPreview");
  });

  it("leaves the members a host can answer in ShellApi", () => {
    // §3.1: a host can screenshot its own tabs, name itself, and find in page.
    expect(SHELL_METHOD_NAMES).toContain("getAppInfo");
    expect(SHELL_METHOD_NAMES).toContain("getTabSwitcherPreviews");
    expect(SHELL_METHOD_NAMES).toContain("find");
    expect(SHELL_METHOD_NAMES).toContain("getFindState");
  });
});

describe("SHELL_METHOD_NAMES", () => {
  it("holds no subscription and no native member", () => {
    for (const method of SHELL_METHOD_NAMES) {
      expect(method.startsWith("on"), method).toBe(false);
      expect(Object.keys(NATIVE_SURFACE_MEMBERS)).not.toContain(method);
    }
  });

  it("names each method once", () => {
    expect(new Set(SHELL_METHOD_NAMES).size).toBe(SHELL_METHOD_NAMES.length);
  });
});

describe("SHELL_EVENT_CHANNELS", () => {
  it("pairs every subscription with a channel from the IPC map", () => {
    const channels = new Set<string>(Object.values(IPC));
    for (const entry of SHELL_EVENT_CHANNELS) {
      expect(entry.member.startsWith("on"), entry.member).toBe(true);
      expect(channels.has(entry.channel), entry.channel).toBe(true);
    }
  });

  it("carries the two snapshot channels the preload splits state over", () => {
    // architecture.md, "How state reaches the shell": the tab side and the run
    // side travel apart, and a transport must map both.
    const byMember = new Map(SHELL_EVENT_CHANNELS.map((entry) => [entry.member, entry.channel]));
    expect(byMember.get("onSnapshot")).toBe(IPC.snapshotChanged);
    expect(byMember.get("onRun")).toBe(IPC.runChanged);
  });

  it("gives each member and each channel once", () => {
    expect(new Set(SHELL_EVENT_CHANNELS.map((entry) => entry.member)).size).toBe(
      SHELL_EVENT_CHANNELS.length,
    );
    expect(new Set(SHELL_EVENT_CHANNELS.map((entry) => entry.channel)).size).toBe(
      SHELL_EVENT_CHANNELS.length,
    );
  });
});
