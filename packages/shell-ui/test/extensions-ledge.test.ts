/**
 * What the shell says about extensions (docs/extensions.md §2), pure: which
 * stand on the Ledge and in what order, how many fit before ⋯, the dot an
 * icon carries, the monogram, where one came from, the sheet's lines, what
 * the extensions page's field finds, where a carried icon lands; and how the
 * window folds main's snapshot in (lib/extensions/use-extensions.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_EXTENSIONS_SNAPSHOT, type ExtensionInfo, type ExtensionsSnapshot } from "@pistachio/shell-contracts/extensions";
import {
  extensionMatches,
  hueOf,
  ledgeCapacity,
  ledgeDotOf,
  ledgeDropIndex,
  ledgeExtensionsOf,
  ledgeTitle,
  monogramOf,
  sheetIsCritical,
  sheetLines,
  sourceLine,
  statusLabel,
  tildePath,
  urlMatchesHosts,
  whereItRuns,
} from "../src/lib/extensions/ledge";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { closeExtensionSheet, dismissExtensionSheet, foldExtensions, openExtensionSheet, turnOnFromLibrary, useExtensions } from "../src/lib/extensions/use-extensions";
import { useAppStore } from "../src/store";
import { hasLivePill } from "../src/components/extensions/StatusPills";
import { agentDefault } from "../src/components/extensions/ApprovalSheet";
import { panelWidthOf } from "../src/components/extensions/ExtensionPanelCard";

function extension(overrides: Partial<ExtensionInfo> & { id: string }): ExtensionInfo {
  return {
    kind: "pistachio",
    name: overrides.id,
    version: "1.0.0",
    description: "",
    iconUrl: null,
    source: { type: "dev", path: `/Users/someone/Pistachio/Extensions/${overrides.id}` },
    enabled: true,
    enabledHere: true,
    pinned: true,
    order: 0,
    agentAllowed: false,
    status: "idle",
    error: null,
    badge: null,
    statusPill: null,
    hasPanel: false,
    panelWidth: null,
    hasAction: false,
    pages: [],
    barCommands: [],
    menuItems: [],
    settings: [],
    tools: [],
    grants: null,
    pending: null,
    verdict: null,
    devPath: null,
    ...overrides,
  };
}

const SHEET = { adds: ["/prs in the Bar"], can: [{ tier: "medium" as const, text: "Talks to api.github.com." }], declares: ["hosts: api.github.com"], manifestHash: "abc" };

describe("the Ledge's icons", () => {
  it("are the pinned ones that are on, or wait on the person, in the person's order", () => {
    const list = ledgeExtensionsOf([
      extension({ id: "c", order: 2 }),
      extension({ id: "a", order: 0 }),
      extension({ id: "unpinned", pinned: false }),
      extension({ id: "off", enabled: false }),
      extension({ id: "waiting", enabled: false, status: "needs-approval", pending: SHEET, order: 5 }),
      extension({ id: "b", order: 1 }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(["a", "b", "c", "waiting"]);
  });

  it("fit six at the card's default width, the ⋯ a slot of its own", () => {
    expect(ledgeCapacity(220, 10)).toBe(6);
    expect(ledgeCapacity(219, 10)).toBe(5);
    expect(ledgeCapacity(220, 3)).toBe(3);
    expect(ledgeCapacity(40, 3)).toBe(0);
    expect(ledgeCapacity(0, 3)).toBe(0);
  });

  it("carry an amber dot when they need the person, a red one when one of theirs is broken", () => {
    expect(ledgeDotOf(extension({ id: "a", status: "needs-approval" }))).toBe("amber");
    expect(ledgeDotOf(extension({ id: "a", status: "paused" }))).toBe("amber");
    expect(ledgeDotOf(extension({ id: "a", pending: SHEET }))).toBe("amber");
    expect(ledgeDotOf(extension({ id: "a", status: "error" }))).toBe("red");
    // A store extension's trouble is never surfaced as a dot.
    expect(ledgeDotOf(extension({ id: "a", status: "error", source: { type: "webstore", cwsId: "x", version: "1" } }))).toBeNull();
    expect(ledgeDotOf(extension({ id: "a" }))).toBeNull();
  });

  it("say what is the matter in their title", () => {
    expect(ledgeTitle(extension({ id: "gh", name: "GitHub inbox" }))).toBe("GitHub inbox");
    expect(ledgeTitle(extension({ id: "gh", name: "GitHub inbox", badge: "3" }))).toBe("GitHub inbox · 3");
    expect(ledgeTitle(extension({ id: "gh", name: "GitHub inbox", enabledHere: false }))).toBe("GitHub inbox · Off in this Profile");
    expect(ledgeTitle(extension({ id: "gh", name: "GitHub inbox", status: "needs-approval", pending: SHEET }))).toBe("GitHub inbox · Waiting for your approval");
  });

  it("land among the others where the pointer lets go", () => {
    const centers = [14, 46, 78, 110];
    // The first, carried past the third's middle: after it.
    expect(ledgeDropIndex(centers, 0, 90)).toBe(2);
    // The last, carried to the start.
    expect(ledgeDropIndex(centers, 3, 0)).toBe(0);
    // Not past anyone's middle: where it was.
    expect(ledgeDropIndex(centers, 1, 50)).toBe(1);
  });
});

describe("an extension's mark and words", () => {
  it("is a monogram on a hue of its own when it has no icon", () => {
    expect(monogramOf("GitHub inbox")).toBe("GI");
    expect(monogramOf("recorder")).toBe("R");
    expect(monogramOf("  ")).toBe("?");
    expect(hueOf("dev.zach.gh-inbox")).toBe(hueOf("dev.zach.gh-inbox"));
    expect(hueOf("dev.zach.gh-inbox")).toBeGreaterThanOrEqual(0);
    expect(hueOf("dev.zach.gh-inbox")).toBeLessThan(360);
  });

  it("says where it came from as the sheet does", () => {
    expect(sourceLine({ type: "dev", path: "/Users/zach/Pistachio/Extensions/gh-inbox" })).toBe("Yours · ~/Pistachio/Extensions/gh-inbox");
    expect(sourceLine({ type: "webstore", cwsId: "x", version: "1" })).toBe("Chrome Web Store");
    expect(sourceLine({ type: "bundled" })).toBe("Made by Pistachio");
    expect(tildePath("/opt/ext")).toBe("/opt/ext");
  });

  it("says where it runs and how it is", () => {
    expect(whereItRuns({ enabled: true, enabledHere: true })).toBe("On in this Profile");
    expect(whereItRuns({ enabled: true, enabledHere: false })).toBe("Off in this Profile");
    expect(whereItRuns({ enabled: false, enabledHere: false })).toBe("Off");
    expect(statusLabel(extension({ id: "a", status: "error", error: { message: "worker.js threw", at: 0 } }))).toBe("Broken: worker.js threw");
  });
});

describe("the approval sheet's lines", () => {
  it("are at most four, broadest first, the rest disclosed", () => {
    const sheet = {
      can: [
        { tier: "low" as const, text: "Adds /prs to the Bar." },
        { tier: "medium" as const, text: "Talks to api.github.com." },
        { tier: "high" as const, text: "Can read pages on github.com." },
        { tier: "medium" as const, text: "Sees your tabs." },
        { tier: "high" as const, text: "The agent can call it." },
      ],
    };
    const { shown, more } = sheetLines(sheet);
    expect(shown.map((line) => line.text)).toEqual(["Can read pages on github.com.", "The agent can call it.", "Talks to api.github.com.", "Sees your tabs."]);
    expect(more).toBe(1);
    expect(sheetIsCritical(sheet)).toBe(false);
    expect(sheetIsCritical({ can: [{ tier: "critical", text: "Runs programs on your Mac." }] })).toBe(true);
  });
});

describe("the extensions page's field", () => {
  it("finds by the starts of words in the name, the description or the id", () => {
    const entry = { name: "GitHub inbox", description: "Your pull requests in the Bar", id: "dev.zach.gh-inbox" };
    expect(extensionMatches(entry, "")).toBe(true);
    expect(extensionMatches(entry, "git")).toBe(true);
    expect(extensionMatches(entry, "pull req")).toBe(true);
    expect(extensionMatches(entry, "gh")).toBe(true);
    expect(extensionMatches(entry, "hub")).toBe(false);
  });
});

describe("a declared menu item's hosts", () => {
  it("take Chrome's match patterns", () => {
    expect(urlMatchesHosts("https://github.com/a/b", [])).toBe(true);
    expect(urlMatchesHosts("https://github.com/a/b", ["<all_urls>"])).toBe(true);
    expect(urlMatchesHosts("https://github.com/a/b", ["*://*.github.com/*"])).toBe(true);
    expect(urlMatchesHosts("https://gist.github.com/x", ["*://*.github.com/*"])).toBe(true);
    expect(urlMatchesHosts("https://example.com/", ["*://*.github.com/*"])).toBe(false);
    expect(urlMatchesHosts("https://example.com/docs/x", ["https://example.com/docs/*"])).toBe(true);
    expect(urlMatchesHosts("http://example.com/docs/x", ["https://example.com/docs/*"])).toBe(false);
    expect(urlMatchesHosts("pistachio://notes/", ["<all_urls>"])).toBe(false);
  });
});

describe("main's snapshot, folded in", () => {
  const snapshot = (extensions: ExtensionInfo[], rest: Partial<ExtensionsSnapshot> = {}): ExtensionsSnapshot => ({ ...EMPTY_EXTENSIONS_SNAPSHOT, extensions, ...rest });

  afterEach(() => {
    closeExtensionSheet();
    useExtensions.setState({ snapshot: EMPTY_EXTENSIONS_SNAPSHOT, loaded: false, sheet: null, panelAnchor: null });
    useAppStore.setState({ notices: [], overlay: "none" });
  });

  it("keeps an extension nobody touched as the same object", () => {
    foldExtensions(snapshot([extension({ id: "a" }), extension({ id: "b" })]));
    const before = useExtensions.getState().snapshot;
    foldExtensions(snapshot([extension({ id: "a" }), extension({ id: "b", badge: "2" })]));
    const after = useExtensions.getState().snapshot;
    expect(after).not.toBe(before);
    expect(after.extensions[0]).toBe(before.extensions[0]);
    expect(after.extensions[1]).not.toBe(before.extensions[1]);
    expect(useExtensions.getState().loaded).toBe(true);
  });

  it("says a folder that appeared once, with Review, and never raises its sheet unbidden", () => {
    foldExtensions(snapshot([extension({ id: "a" })]));
    foldExtensions(snapshot([extension({ id: "a" }), extension({ id: "gh", name: "GitHub inbox", enabled: false, status: "needs-approval", pending: SHEET })]));
    const notices = useAppStore.getState().notices;
    expect(notices.map((notice) => notice.message)).toEqual(["New extension: GitHub inbox"]);
    expect(notices[0]?.action?.label).toBe("Review");
    expect(useExtensions.getState().sheet).toBeNull();
    // Review: the sheet, over everything.
    notices[0]?.action?.run();
    expect(useExtensions.getState().sheet).toEqual({ kind: "extension", id: "gh" });
    expect(useAppStore.getState().overlay).toBe("extension-sheet");
    // Approved (elsewhere): the sheet has nothing to ask, and goes.
    foldExtensions(snapshot([extension({ id: "a" }), extension({ id: "gh", name: "GitHub inbox" })]));
    expect(useExtensions.getState().sheet).toBeNull();
    expect(useAppStore.getState().overlay).toBe("none");
  });

  it("raises a store install's sheet by itself, the person having asked for it", () => {
    foldExtensions(snapshot([]));
    const pendingInstall = { cwsId: "eimadpbcbfnmbkopoojfekhnkhdbieeh", name: "Dark Reader", description: "", iconUrl: null, verdict: { kind: "works" as const }, sheet: SHEET };
    foldExtensions(snapshot([], { pendingInstall }));
    expect(useExtensions.getState().sheet).toEqual({ kind: "install", cwsId: pendingInstall.cwsId });
    expect(useAppStore.getState().overlay).toBe("extension-sheet");
    foldExtensions(snapshot([], { pendingInstall: null }));
    expect(useExtensions.getState().sheet).toBeNull();
    // Put down with × or ⎋, the install is answered Not now — so the next ask of the same extension comes up again.
    const asked: unknown[] = [];
    setShellApi({ extensions: (request: unknown) => (asked.push(request), Promise.resolve({ type: "ok" })) } as unknown as ShellApiBridge);
    foldExtensions(snapshot([], { pendingInstall }));
    expect(useExtensions.getState().sheet).toEqual({ kind: "install", cwsId: pendingInstall.cwsId });
    dismissExtensionSheet();
    expect(asked).toEqual([{ type: "denyInstall", cwsId: pendingInstall.cwsId }]);
    expect(useExtensions.getState().sheet).toBeNull();
  });

  it("brings a library entry's sheet up at once when it is turned on and comes back waiting, with no notice beside it", async () => {
    foldExtensions(snapshot([extension({ id: "a" })]));
    const asked: unknown[] = [];
    setShellApi({
      extensions: (request: unknown) => {
        asked.push(request);
        return Promise.resolve({ type: "ok" });
      },
    } as unknown as ShellApiBridge);
    await turnOnFromLibrary("com.pistachio.recorder");
    expect(asked).toEqual([{ type: "setEnabled", id: "com.pistachio.recorder", enabled: true }]);
    // Not waiting yet: no sheet. Main publishes it waiting on the person: its sheet, over everything.
    expect(useExtensions.getState().sheet).toBeNull();
    foldExtensions(snapshot([extension({ id: "a" }), extension({ id: "com.pistachio.recorder", name: "Recorder", enabled: false, status: "needs-approval", pending: SHEET })]));
    expect(useExtensions.getState().sheet).toEqual({ kind: "extension", id: "com.pistachio.recorder" });
    expect(useAppStore.getState().overlay).toBe("extension-sheet");
    expect(useAppStore.getState().notices).toEqual([]);
  });

  it("opens no sheet for one with nothing to approve", () => {
    foldExtensions(snapshot([extension({ id: "a" })]));
    openExtensionSheet({ kind: "extension", id: "a" });
    expect(useExtensions.getState().sheet).toBeNull();
  });
});

describe("the status pills", () => {
  it("draw a pill only for an extension that is on — here, or recording a window from another Profile", () => {
    const pill = { text: "● Recording · Recorder", actions: [{ id: "stop", title: "Stop" }] };
    expect(hasLivePill(extension({ id: "rec", statusPill: pill }))).toBe(true);
    expect(hasLivePill(extension({ id: "rec", statusPill: pill, enabledHere: false }))).toBe(false);
    // On in Profile A alone, recording a window there, the person in Profile B: the capture goes on, so its Stop stays.
    expect(hasLivePill(extension({ id: "rec", statusPill: pill, enabledHere: false, captures: ["t1"] }))).toBe(true);
    expect(hasLivePill(extension({ id: "rec", statusPill: pill, enabled: false, captures: ["t1"] }))).toBe(false);
    expect(hasLivePill(extension({ id: "rec", statusPill: pill, enabled: false }))).toBe(false);
    expect(hasLivePill(extension({ id: "rec" }))).toBe(false);
  });
});

describe("the approval sheet's agent access", () => {
  it("is on for a first approval of an extension with tools, and as the person left it after", () => {
    expect(agentDefault({ first: true, tools: true, agentAllowed: false })).toBe(true);
    expect(agentDefault({ first: true, tools: false, agentAllowed: false })).toBe(false);
    expect(agentDefault({ first: false, tools: true, agentAllowed: false })).toBe(false);
    expect(agentDefault({ first: false, tools: true, agentAllowed: true })).toBe(true);
  });
});

describe("the panel's width", () => {
  it("is the one the manifest declares, within 240–480, and 360 when it names none", () => {
    expect(panelWidthOf(extension({ id: "a" }))).toBe(360);
    expect(panelWidthOf(extension({ id: "a", panelWidth: 480 }))).toBe(480);
    expect(panelWidthOf(extension({ id: "a", panelWidth: 240 }))).toBe(240);
    expect(panelWidthOf(extension({ id: "a", panelWidth: 9_000 }))).toBe(480);
  });
});
