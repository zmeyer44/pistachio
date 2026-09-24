/**
 * `<Button asChild>` (packages/shell-ui/src/components/ui/button.tsx).
 *
 * The bug this pins CRASHED THE BROWSER APP: the Button handed Radix's Slot
 * three children — prefix, children, suffix — and Slot merges onto exactly
 * one element, so Settings → Account threw "Slot failed to slot onto its
 * children. Expected a single React element child or `Slottable`." into the
 * boundary that replaces the whole shell.
 *
 * There is no DOM runner in this package, so the structure is pinned here
 * and the render is pinned by `apps/desktop/e2e/tests/web-split-links.spec.ts`.
 * The structural assertion is the one that matters: Slot finds its target by
 * looking for the `Slottable` marker among its children, so what is checked
 * is exactly what Slot checks.
 */

import { Children, createElement, Fragment, isValidElement, type ReactNode } from "react";
import { Slottable } from "@radix-ui/react-slot";
import { describe, expect, it } from "vitest";
import { slotChildren } from "../src/components/ui/button";

/** Radix's own test, from `@radix-ui/react-slot`: the marker is on the type. */
function isSlottable(node: ReactNode): boolean {
  return (
    isValidElement(node) &&
    typeof node.type === "function" &&
    "__radixId" in node.type &&
    (node.type as { __radixId?: symbol }).__radixId === Symbol.for("radix.slottable")
  );
}

const anchor = createElement("a", { href: "/somewhere" }, "Open the web app");
const icon = createElement("svg", { key: "icon" });

describe("what asChild hands to Slot", () => {
  it("marks the caller's child as the element to slot onto", () => {
    const children = slotChildren(icon, anchor, null);
    // Exactly one Slottable, and it wraps the child the caller passed — not
    // the prefix, which would put the button's href-bearing element inside a
    // decorative icon.
    const marked = Children.toArray(children).filter(isSlottable);
    expect(marked).toHaveLength(1);
    expect((marked[0] as { props: { children: unknown } }).props.children).toBe(anchor);
  });

  it("keeps the prefix and the suffix outside it, in order", () => {
    const suffix = createElement("span", null, "→");
    const flat = Children.toArray(slotChildren(icon, anchor, suffix));
    expect(flat).toHaveLength(3);
    expect(isSlottable(flat[0])).toBe(false);
    expect(isSlottable(flat[1])).toBe(true);
    expect(isSlottable(flat[2])).toBe(false);
  });

  it("keys every slot, so React never warns about a list", () => {
    for (const node of slotChildren(icon, anchor, null)) {
      expect(isValidElement(node)).toBe(true);
      expect((node as { key: string | null }).key).not.toBeNull();
    }
  });

  it("still marks the child when there is no prefix or suffix at all", () => {
    // The common case, and the one that happened to work before: it must go
    // through the same path rather than a second one that could rot.
    const flat = Children.toArray(slotChildren(undefined, anchor, undefined));
    expect(flat.filter(isSlottable)).toHaveLength(1);
  });

  it("wraps the caller's nodes rather than rewriting them", () => {
    // The prefix may be a keyed element the caller owns; cloning it to add a
    // key of ours would silently drop theirs.
    const [prefix] = slotChildren(icon, anchor, null);
    expect(isValidElement(prefix) && prefix.type).toBe(Fragment);
    expect((prefix as { props: { children: unknown } }).props.children).toBe(icon);
  });

  it("is the shape Radix's own Slottable produces", () => {
    // A guard on the import itself: if Radix ever renamed the marker, the
    // helper would compile and silently stop being found.
    expect(isSlottable(createElement(Slottable, null, anchor))).toBe(true);
  });
});
