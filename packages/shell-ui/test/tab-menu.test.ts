import { describe, expect, it } from "vitest";
import type { SidebarFolder } from "@pistachio/shell-contracts/sidebar";
import { moveToFolderEntries } from "../src/chrome/tab-menu-entries";

function folder(id: string, name: string): SidebarFolder {
  return { kind: "folder", id, name, collapsed: false, color: null, emoji: null };
}

describe("tab menu — move to folder", () => {
  it("offers every folder but the one the item is already in, and moves on select", () => {
    const moved: string[] = [];
    const entries = moveToFolderEntries([folder("a", "Research"), folder("b", ""), folder("c", "Later")], "b", (id) => moved.push(id));
    const labels = entries.map((entry) => entry.label);
    expect(labels).toEqual(["Move to “Research”", "Move to “Later”"]);
    const first = entries[0];
    if (first === undefined) throw new Error("expected an entry");
    first.onSelect();
    expect(moved).toEqual(["a"]);
  });

  it("is empty without folders, so the menu shows no dead section", () => {
    expect(moveToFolderEntries([], null, () => {})).toEqual([]);
  });
});
