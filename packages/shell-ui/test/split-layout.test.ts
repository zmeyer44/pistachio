import { describe, expect, it } from "vitest";
import { SPLIT_DROP_PREVIEW_ID, splitDropPreviewLayout, splitLayout } from "../src/lib/split-layout";

describe("splitLayout", () => {
  it("lays any pane count along the requested linear axis", () => {
    expect(splitLayout(["a", "b", "c", "d"], "vertical")).toMatchObject({
      kind: "split",
      axis: "vertical",
      children: [
        { kind: "pane", tabId: "a" },
        { kind: "pane", tabId: "b" },
        { kind: "pane", tabId: "c" },
        { kind: "pane", tabId: "d" },
      ],
    });
    expect(splitLayout(["a", "b", "c"], "horizontal")).toMatchObject({ kind: "split", axis: "horizontal" });
  });

  it("uses a bottom-spanning three-pane mosaic and a balanced four-pane grid", () => {
    expect(splitLayout(["a", "b", "c"], "grid")).toEqual({
      kind: "split",
      axis: "horizontal",
      children: [
        {
          kind: "split",
          axis: "vertical",
          children: [{ kind: "pane", tabId: "a" }, { kind: "pane", tabId: "b" }],
        },
        { kind: "pane", tabId: "c" },
      ],
    });
    expect(splitLayout(["a", "b", "c", "d"], "grid")).toMatchObject({
      kind: "split",
      axis: "vertical",
      children: [
        { kind: "split", axis: "horizontal" },
        { kind: "split", axis: "horizontal" },
      ],
    });
  });

  it("can put the spanning pane on any edge", () => {
    expect(splitLayout(["a", "b", "c"], "grid", "span-top")).toMatchObject({
      axis: "horizontal",
      children: [{ kind: "pane", tabId: "a" }, { kind: "split", axis: "vertical" }],
    });
    expect(splitLayout(["a", "b", "c"], "grid", "span-left")).toMatchObject({
      axis: "vertical",
      children: [{ kind: "pane", tabId: "a" }, { kind: "split", axis: "horizontal" }],
    });
    expect(splitLayout(["a", "b", "c"], "grid", "span-right")).toMatchObject({
      axis: "vertical",
      children: [{ kind: "split", axis: "horizontal" }, { kind: "pane", tabId: "c" }],
    });
  });

  it("previews the exact edge layout a one- or two-pane split will commit", () => {
    expect(splitDropPreviewLayout(["a"], "vertical", "span-bottom", "left")).toEqual({
      kind: "split",
      axis: "vertical",
      children: [
        { kind: "pane", tabId: SPLIT_DROP_PREVIEW_ID },
        { kind: "pane", tabId: "a" },
      ],
    });
    expect(splitDropPreviewLayout(["a", "b"], "vertical", "span-bottom", "bottom")).toEqual({
      kind: "split",
      axis: "horizontal",
      children: [
        {
          kind: "split",
          axis: "vertical",
          children: [{ kind: "pane", tabId: "a" }, { kind: "pane", tabId: "b" }],
        },
        { kind: "pane", tabId: SPLIT_DROP_PREVIEW_ID },
      ],
    });
  });

  it("does not offer a fifth pane", () => {
    expect(splitDropPreviewLayout(["a", "b", "c", "d"], "grid", "span-bottom", "right")).toBeNull();
  });
});
