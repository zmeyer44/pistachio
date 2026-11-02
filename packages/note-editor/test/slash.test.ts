/**
 * What `/` offers (docs/notes.md §5): the catalog, and finding a block by
 * what a person would call it rather than by what the schema calls it.
 */

import { describe, expect, it } from "vitest";
import { filterSlashCommands, SLASH_COMMANDS, SLASH_GROUPS, slashOpensMenu, slashQueryShowsMenu } from "../src/slash";

describe("the catalog", () => {
  it("is the sixteen blocks the spec names, each declared once", () => {
    const ids = SLASH_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "paragraph",
      "heading1",
      "heading2",
      "heading3",
      "bulletList",
      "orderedList",
      "taskList",
      "toggle",
      "blockquote",
      "callout",
      "codeBlock",
      "divider",
      "table",
      "image",
      "embed",
      "htmlBlock",
    ]);
  });

  it("gives every row a title, a group and an icon to draw", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.icon.length).toBeGreaterThan(0);
      expect(SLASH_GROUPS).toContain(command.group);
    }
  });
});

describe("filterSlashCommands", () => {
  it("shows the whole catalog before anything is typed, in its own order", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
    expect(filterSlashCommands("")[0]?.id).toBe("paragraph");
  });

  it("finds a block by the word a person would use", () => {
    expect(filterSlashCommands("todo")[0]?.id).toBe("taskList");
    expect(filterSlashCommands("checkbox")[0]?.id).toBe("taskList");
    expect(filterSlashCommands("h2")[0]?.id).toBe("heading2");
    expect(filterSlashCommands("bullet")[0]?.id).toBe("bulletList");
    expect(filterSlashCommands("hr")[0]?.id).toBe("divider");
    expect(filterSlashCommands("photo")[0]?.id).toBe("image");
    expect(filterSlashCommands("quote")[0]?.id).toBe("blockquote");
    expect(filterSlashCommands("youtube")[0]?.id).toBe("embed");
    expect(filterSlashCommands("widget")[0]?.id).toBe("htmlBlock");
    expect(filterSlashCommands("warning")[0]?.id).toBe("callout");
    expect(filterSlashCommands("collapse")[0]?.id).toBe("toggle");
  });

  it("takes a query with a space in it, as Notion does", () => {
    expect(filterSlashCommands("heading 1")[0]?.id).toBe("heading1");
    expect(filterSlashCommands("html block")[0]?.id).toBe("htmlBlock");
  });

  it("answers nothing rather than everything when nothing matches", () => {
    expect(filterSlashCommands("zzzzqq")).toEqual([]);
  });
});

describe("slashOpensMenu", () => {
  it("opens at the start of a line and after a space", () => {
    expect(slashOpensMenu("")).toBe(true);
    expect(slashOpensMenu("write ")).toBe(true);
  });

  it("stays out of the way mid-word — a path or a date is not a command", () => {
    expect(slashOpensMenu("src")).toBe(false);
    expect(slashOpensMenu("2026")).toBe(false);
  });
});

describe("slashQueryShowsMenu", () => {
  it("stays open through a spaced query that still matches, and closes on one that does not", () => {
    expect(slashQueryShowsMenu("")).toBe(true);
    expect(slashQueryShowsMenu("head")).toBe(true);
    expect(slashQueryShowsMenu("heading 1")).toBe(true);
    expect(slashQueryShowsMenu(" ")).toBe(false);
    expect(slashQueryShowsMenu("and then we")).toBe(false);
  });
});
