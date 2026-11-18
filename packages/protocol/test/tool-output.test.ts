import { describe, expect, it } from "vitest";
import { foldRunEvent, toolOutputOf, type RunSummary } from "../src/index.js";

describe("toolOutputOf", () => {
  it("names the note a note tool wrote", () => {
    const note = { id: "n-1", title: "Waymo transit rewards", updatedAt: "2026-09-23T10:00:00.000Z" };
    expect(toolOutputOf("note.create", note)).toEqual({ kind: "note", action: "created", id: "n-1", title: "Waymo transit rewards" });
    expect(toolOutputOf("note.update", note)).toEqual({ kind: "note", action: "updated", id: "n-1", title: "Waymo transit rewards" });
  });

  it("names the page an artifact tool built, with its address", () => {
    const view = { id: "a-1", url: "https://pistachio.run/artifact/a-1", title: "Morning news", brief: "", updatedAt: "", revision: 1 };
    expect(toolOutputOf("artifact.create", view)).toEqual({
      kind: "artifact",
      action: "created",
      id: "a-1",
      title: "Morning news",
      url: "https://pistachio.run/artifact/a-1",
    });
  });

  it("names the extension a build made or changed, and whether it waits on the person", () => {
    const built = { id: "dev.local.night-desk", title: "Night desk", slug: "night-desk", waiting: true, created: true, adds: [], asks: [], runs: [], errors: [], report: "It sets a backdrop." };
    expect(toolOutputOf("ext.build", built)).toEqual({ kind: "extension", action: "created", id: "dev.local.night-desk", title: "Night desk", waiting: true });
    expect(toolOutputOf("ext.build", { ...built, created: false, waiting: false })).toEqual({ kind: "extension", action: "updated", id: "dev.local.night-desk", title: "Night desk", waiting: false });
    // One that never loaded has no id: there is no sheet for a card to open.
    expect(toolOutputOf("ext.build", { ...built, id: null })).toBeNull();
    // The author's own steps, and the list, leave nothing to open.
    expect(toolOutputOf("ext.draft.write", { id: "x", title: "pistachio.json" })).toBeNull();
    expect(toolOutputOf("ext.list", { id: "x", title: "y" })).toBeNull();
  });

  it("gives nothing for reads, deletes, and malformed results", () => {
    expect(toolOutputOf("note.read", { id: "n-1", title: "x" })).toBeNull();
    expect(toolOutputOf("note.delete", { id: "n-1", title: "x" })).toBeNull();
    expect(toolOutputOf("note.create", null)).toBeNull();
    expect(toolOutputOf("note.create", { title: "no id" })).toBeNull();
    expect(toolOutputOf("artifact.create", { id: "a-1", title: "no url" })).toBeNull();
  });

  it("falls back to Untitled for a note with no title", () => {
    expect(toolOutputOf("note.create", { id: "n-2", title: "" })).toMatchObject({ title: "Untitled" });
  });
});

describe("folding a cloud run's tool detail", () => {
  it("records the output a completed note call carries", () => {
    const at = "2026-09-23T10:00:00.000Z";
    let run = foldRunEvent(null, { t: "run.created", run: { toolCalls: [], messages: [], turns: 1 } as unknown as RunSummary }, at);
    run = foldRunEvent(run, { t: "tool.started", toolId: "t-1", name: "note.create", label: "Write note", tabId: null }, at);
    run = foldRunEvent(run, { t: "tool.completed", toolId: "t-1" }, at);
    run = foldRunEvent(run, { t: "tool.detail", toolId: "t-1", detail: "", summary: "Wrote: x", data: { id: "n-1", title: "x" } }, at);
    expect(run.toolCalls[0]!.output).toEqual({ kind: "note", action: "created", id: "n-1", title: "x" });
  });
});
