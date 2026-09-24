/**
 * What `/` offers (docs/notes.md §5): the catalog, and finding a block by
 * what a person would call it rather than by what the schema calls it.
 */

import { describe, expect, it } from "vitest";
import { filterSlashCommands, SLASH_COMMANDS, SLASH_LIMIT, slashOpensMenu } from "../src/lib/notes-slash";

describe("the catalog", () => {
  it("is the eleven blocks the spec names, each declared once", () => {
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
      "blockquote",
      "codeBlock",
      "divider",
      "table",
      "image",
    ]);
  });

  it("gives every row a title, a group and an icon to draw", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.icon.length).toBeGreaterThan(0);
      expect(["Basic", "Lists", "Blocks"]).toContain(command.group);
    }
  });
});

describe("filterSlashCommands", () => {
  it("shows the catalog before anything is typed", () => {
    expect(filterSlashCommands("")).toHaveLength(SLASH_LIMIT);
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
  });

  it("answers nothing rather than everything when nothing matches", () => {
    expect(filterSlashCommands("zzzzqq")).toEqual([]);
  });

  it("never offers more rows than the menu shows", () => {
    expect(filterSlashCommands("list").length).toBeLessThanOrEqual(SLASH_LIMIT);
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
