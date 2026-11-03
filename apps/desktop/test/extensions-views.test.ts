/** The view registry (main/extensions/views.ts): what a view's navigation means for what it holds. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { ViewRegistry } from "../src/main/extensions/views";

function contents(id: number): WebContents & EventEmitter {
  const emitter = new EventEmitter() as WebContents & EventEmitter;
  Object.assign(emitter, { id, isDestroyed: () => false });
  return emitter;
}

describe("the view registry", () => {
  it("lets go of what a document held when its renderer goes, keeping the identity for the page that comes back", () => {
    const events = { console: vi.fn(), gesture: vi.fn(), dropped: vi.fn(), renewed: vi.fn() };
    const views = new ViewRegistry(events);
    const view = contents(5);
    views.register(view, "dev.x", "panel");
    view.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    expect(events.renewed).toHaveBeenCalledWith(5, expect.objectContaining({ extensionId: "dev.x", context: "panel" }));
    expect(events.dropped).not.toHaveBeenCalled();
    expect(views.get(5)?.extensionId).toBe("dev.x");
  });

  it("marks a view that made a subframe for its life, once, through a reload; a new contents starts clean", () => {
    const events = { console: vi.fn(), gesture: vi.fn(), dropped: vi.fn(), renewed: vi.fn(), framed: vi.fn() };
    const views = new ViewRegistry(events);
    const view = contents(3);
    Object.assign(view, { mainFrame: { url: "pistachio-ext://dev.x/__pistachio__/worker.html" } });
    views.register(view, "dev.x", "worker");
    expect(views.get(3)?.framed).toBe(false);
    // The top frame itself: no mark.
    view.emit("frame-created", {}, { frame: (view as unknown as { mainFrame: unknown }).mainFrame });
    expect(views.get(3)?.framed).toBe(false);
    view.emit("frame-created", {}, { frame: { url: "about:blank" } });
    expect(views.get(3)?.framed).toBe(true);
    expect(events.framed).toHaveBeenCalledTimes(1);
    view.emit("frame-created", {}, { frame: { url: "about:blank" } });
    expect(events.framed).toHaveBeenCalledTimes(1);
    // The document reloaded on its origin: the same contents, still marked (its realms are not known to be gone).
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "pistachio-ext://dev.x/__pistachio__/worker.html" });
    views.register(view, "dev.x", "worker");
    expect(views.get(3)?.framed).toBe(true);
    const fresh = contents(4);
    views.register(fresh, "dev.x", "worker");
    expect(views.get(4)?.framed).toBe(false);
  });

  it("keeps a view's identity through a reload or a page of its own, letting go of what the old document held; drops it when it leaves the origin", () => {
    const events = { console: vi.fn(), gesture: vi.fn(), dropped: vi.fn(), renewed: vi.fn() };
    const views = new ViewRegistry(events);
    const view = contents(7);
    views.register(view, "dev.x", "page");
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "pistachio-ext://dev.x/page.html?rec=2" });
    expect(events.renewed).toHaveBeenCalledWith(7, expect.objectContaining({ extensionId: "dev.x", context: "page" }));
    expect(events.dropped).not.toHaveBeenCalled();
    expect(views.get(7)?.extensionId).toBe("dev.x");
    // A hash change or a subframe is not a new document.
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url: "pistachio-ext://dev.x/page.html#top" });
    view.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false, url: "https://example.com/" });
    expect(events.renewed).toHaveBeenCalledTimes(1);
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://example.com/" });
    expect(events.dropped).toHaveBeenCalledWith(7, expect.objectContaining({ extensionId: "dev.x" }));
    expect(views.get(7)).toBeNull();
  });
});
