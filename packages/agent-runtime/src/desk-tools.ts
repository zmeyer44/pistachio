/**
 * The desk's tools (docs/desk-agent.md §2): a tab group laid out as a desk
 * of windows is the agent's workspace for a request, and the group keeps a
 * context of files and facts for the task. These tools read and arrange
 * that desk and read and add to that context.
 *
 * Host-supplied, like the notes tools: the desktop builds a `DeskToolHost`
 * over the shell's desk and the group's context store, and a run without
 * one (the cloud, a console turn with no desk up) has none of these tools.
 * The host hands back the desk as the model reads it — text — so this
 * package stays ignorant of how the shell draws a desk.
 */

import { tool } from "ai";
import { z } from "zod";
import type { DeskToolRequest } from "@pistachio/protocol";
import type { AiAgentRunCallbacks } from "./runner.js";

/** Where a window can be put: a half, a quarter, the middle, or the whole desk. */
export const DESK_TOOL_ZONES = ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "center", "full"] as const;

/** A change to the desk's layout, all at once (the shell's `DeskArrangePlan`). */
export interface DeskToolPlan {
  layout?: "tile" | "cascade";
  place?: Array<{ tabId: string; zone?: (typeof DESK_TOOL_ZONES)[number]; box?: { x: number; y: number; w: number; h: number } }>;
  putAway?: string[];
  bringOut?: string[];
}

export interface DeskToolHost {
  /** The desk as it stands, as the model reads it: the windows, the dock, the context. */
  state(): Promise<string>;
  /** Change the layout; the desk as it then stands. */
  arrange(plan: DeskToolPlan): Promise<string>;
  /** Pin a short note to a window's frame, or clear it (null). */
  note(tabId: string, text: string | null): Promise<void>;
  /** Move tabs out of the group; they stay open. */
  ungroup(tabIds: string[]): Promise<void>;
  /** One context item: its text, or a file (an image, a PDF) for the model to look at. */
  read(itemId: string): Promise<{ text: string } | { file: { dataUrl: string; mediaType: string; name: string } }>;
  /** Save a fact or a snippet to the group's context; its id. */
  save(input: { kind: "fact" | "snippet"; text: string; url?: string; title?: string }): Promise<{ id: string }>;
}

/** A file a tool read, attached to the conversation right after its result (as a screenshot is). */
export type AttachFile = (toolCallId: string, file: { dataUrl: string; mediaType: string; name: string }) => void;

export const DESK_RULES = `
Desk rules:
- The person is working at a desk: a tab group whose tabs are laid out as windows, for one task. The desk is your workspace for this request, and the message tells you what is on it (under "Desk:"): every window with its place and which one is in use, the group's tabs in the dock, and the group's context. Work from it; list tabs only when it may have changed.
- Stay on the desk. Its tabs are the ones you can use; a tab you open joins the group and comes out onto the desk beside the window in use, without taking the person's keyboard. Anything outside the group — another tab, their mail, their calendar — ask about first.
- Use the desk to answer. You may rearrange the person's windows: with desk_arrange, put what should be compared side by side (left and right halves, or quarters), bring out what matters, put away what is in the way, tile or cascade when asked to tidy. Every layout you make can be undone in one click, so arrange confidently when it helps, and say what you did.
- Pin a short note (a few words) to a window with desk_note when that window holds part of the answer, such as "Lands 11:05, before check-in". Notes clear when the next turn starts.
- The group's context keeps the task's files and facts. Read what a request needs with context_read. Save what the person will want again — confirmation numbers, times, addresses, decisions — with context_save, and say that you saved it.
- The context's files open on the desk as document windows (a PDF, a Word or Excel file, a picture, notes), listed among the windows as "document file:<id>". Arrange them as you arrange tabs: place, bring out or put away "file:<the item's id>" with desk_arrange. A file the person @mentions in their message comes with the message; you need not read it again.
- A window marked "minimized" is one the person made small and set aside, most often peeking up at the desk's foot, where they can see it at a glance. Leave it minimized unless the answer needs it; placing it with desk_arrange gives it its size back.
- Before moving a tab out of the group with desk_ungroup, ask with ask_user.
- Name windows by their titles; the person never sees tab ids.
`;

function deskLabel(request: DeskToolRequest): string {
  switch (request.name) {
    case "desk.state":
      return "Looking at the desk";
    case "desk.arrange":
      return "Arranging the desk";
    case "desk.note":
      return request.text === null ? "Clearing a note" : "Pinning a note";
    case "desk.ungroup":
      return request.tabIds.length === 1 ? "Moving a tab out of the group" : "Moving tabs out of the group";
    case "context.read":
      return "Reading the group's context";
    case "context.save":
      return request.kind === "fact" ? "Saving a fact" : "Saving a snippet";
  }
}

function deskDetail(request: DeskToolRequest): string {
  switch (request.name) {
    case "desk.arrange":
      return request.summary;
    case "desk.note":
      return request.text ?? "";
    case "context.save":
      return request.text.length > 80 ? `${request.text.slice(0, 80)}…` : request.text;
    default:
      return "";
  }
}

/** What an arrangement does, in a few words, for the trace. */
function planSummary(plan: DeskToolPlan): string {
  const parts: string[] = [];
  if (plan.layout !== undefined) parts.push(plan.layout === "tile" ? "tiled the windows" : "cascaded the windows");
  if ((plan.place?.length ?? 0) > 0) parts.push(`placed ${String(plan.place!.length)} window${plan.place!.length === 1 ? "" : "s"}`);
  if ((plan.bringOut?.length ?? 0) > 0) parts.push(`brought out ${String(plan.bringOut!.length)}`);
  if ((plan.putAway?.length ?? 0) > 0) parts.push(`put away ${String(plan.putAway!.length)}`);
  return parts.join(", ");
}

const TAB_ID = z.string().min(1).describe("A window's id: a tab id from the desk block, tabs_list, or tab_open — or file:<item id> for one of the context's documents.");
const BOX = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    w: z.number().min(5).max(100),
    h: z.number().min(5).max(100),
  })
  .describe("A box as percents of the desk: its left, top, width and height.");

export function deskTools(host: DeskToolHost, callbacks: AiAgentRunCallbacks, attach: AttachFile) {
  const perform = async <T,>(request: DeskToolRequest, work: () => Promise<T>, summary: (value: T) => string) => {
    const toolId = callbacks.toolStarted(request, deskLabel(request), deskDetail(request));
    callbacks.changed();
    try {
      const value = await work();
      callbacks.toolCompleted(toolId, { summary: summary(value), data: value });
      callbacks.changed();
      return { ok: true as const, result: value };
    } catch (error: unknown) {
      callbacks.toolFailed(toolId, error);
      callbacks.changed();
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const optional = <T,>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);
  return {
    desk_state: tool({
      description:
        "The desk as it stands now: every window (a tab's id, title and address, or a document's file:<id> and name; its place as percents of the desk; which is in use), the group's tabs in the dock, and the group's context. The message already carries it; call this after the desk may have changed.",
      inputSchema: z.object({}),
      execute: async () => perform({ name: "desk.state" }, () => host.state(), () => "Read the desk"),
    }),
    desk_arrange: tool({
      description:
        "Change the desk's layout in one go: tile or cascade every window; place named windows in a zone (halves, quarters, center, full) or a box of your own; bring out tabs from the dock, or the context's documents (file:<item id>); put windows away into the dock (a document into the Stack). The person's keyboard stays where it is. Returns the desk as it then stands.",
      inputSchema: z.object({
        layout: z.enum(["tile", "cascade"]).nullable().describe("Tile or cascade every window first, or null."),
        place: z
          .array(
            z.object({
              tabId: TAB_ID,
              zone: z.enum(DESK_TOOL_ZONES).nullable().describe("Where to put the window, or null to give a box instead."),
              box: BOX.nullable(),
            }),
          )
          .max(24)
          .nullable()
          .describe("Windows to put somewhere; a tab in the dock named here comes out to that place."),
        bringOut: z.array(TAB_ID).max(24).nullable().describe("Tabs in the dock to bring out where the desk has room."),
        putAway: z.array(TAB_ID).max(24).nullable().describe("Windows to put away into the dock (they stay open)."),
      }),
      execute: async ({ layout, place, bringOut, putAway }) => {
        const plan: DeskToolPlan = {
          ...(layout === null ? {} : { layout }),
          ...(place === null || place.length === 0
            ? {}
            : { place: place.map((entry) => ({ tabId: entry.tabId, ...(entry.zone === null ? {} : { zone: entry.zone }), ...(entry.box === null ? {} : { box: entry.box }) })) }),
          ...(optional(bringOut) === undefined || bringOut!.length === 0 ? {} : { bringOut: bringOut! }),
          ...(optional(putAway) === undefined || putAway!.length === 0 ? {} : { putAway: putAway! }),
        };
        return perform({ name: "desk.arrange", summary: planSummary(plan) }, () => host.arrange(plan), () => planSummary(plan) || "Left the desk as it was");
      },
    }),
    desk_note: tool({
      description: "Pin a short note (a few words) to a window's frame, where the person sees it, or clear the window's note with null.",
      inputSchema: z.object({
        tabId: TAB_ID,
        text: z.string().max(80).nullable().describe("The note, or null to clear it."),
      }),
      execute: async ({ tabId, text }) =>
        perform({ name: "desk.note", tabId, text }, async () => {
          await host.note(tabId, text === null || text.trim() === "" ? null : text.trim());
          return { tabId };
        }, () => (text === null ? "Cleared the note" : "Pinned the note")),
    }),
    desk_ungroup: tool({
      description: "Move tabs out of the group (they stay open, beside it). Only after the person agreed with ask_user.",
      inputSchema: z.object({ tabIds: z.array(TAB_ID).min(1).max(24) }),
      execute: async ({ tabIds }) =>
        perform({ name: "desk.ungroup", tabIds }, async () => {
          await host.ungroup(tabIds);
          return { tabIds };
        }, () => `Moved ${String(tabIds.length)} tab${tabIds.length === 1 ? "" : "s"} out of the group`),
    }),
    context_read: tool({
      description:
        "Read one item of the group's context by its id from the desk block: a fact's or a text file's text, or an image or PDF, which follows the result as a file you can look at.",
      inputSchema: z.object({ id: z.string().min(1).describe("The item's id, from the desk block's context list.") }),
      execute: async ({ id }, { toolCallId }) =>
        perform({ name: "context.read", id }, async () => {
          const read = await host.read(id);
          if ("text" in read) return { text: read.text };
          // The bytes never ride inside the result (some providers serialise
          // results as JSON text); the file follows as its own message.
          attach(toolCallId, read.file);
          return { file: read.file.name, content: "attached as the next message" };
        }, () => "Read the item"),
    }),
    context_save: tool({
      description:
        "Save a fact or a snippet to the group's context, where the person and later turns find it: a confirmation number, a time, an address, a decision. Keep a fact to one line.",
      inputSchema: z.object({
        kind: z.enum(["fact", "snippet"]),
        text: z.string().min(1).max(4_000),
        url: z.string().url().nullable().describe("The page it came from, or null."),
        title: z.string().max(300).nullable().describe("That page's title, or null."),
      }),
      execute: async ({ kind, text, url, title }) =>
        perform(
          { name: "context.save", kind, text },
          () => host.save({ kind, text, ...(url === null ? {} : { url }), ...(title === null ? {} : { title }) }),
          () => (kind === "fact" ? "Saved the fact" : "Saved the snippet"),
        ),
    }),
  };
}
