import { describe, expect, it, vi } from "vitest";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import {
  buildPageContextMenu,
  contextMediaScript,
  menuExcerpt,
  pageFileName,
  type PageContextMenuActions,
  type PageContextMenuState,
} from "../src/main/page-context-menu";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 10,
    y: 20,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "https://example.com/article",
    frameURL: "https://example.com/article",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { url: "", policy: "default" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "utf-8",
    formControlType: "none",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: true,
      isLooping: false,
      isControlsVisible: true,
      canToggleControls: true,
      canPrint: false,
      canSave: true,
      canShowPictureInPicture: true,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: true,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  } as ContextMenuParams;
}

function state(overrides: Partial<PageContextMenuState> = {}): PageContextMenuState {
  return {
    canGoBack: true,
    canGoForward: false,
    copyAllowed: true,
    pasteAllowed: true,
    downloadAllowed: true,
    printAllowed: true,
    inReaderView: false,
    platform: "darwin",
    shortcuts: DEFAULT_SHORTCUTS,
    searchProvider: "google",
    ...overrides,
  };
}

function actions(): PageContextMenuActions {
  return {
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    openInNewTab: vi.fn(),
    openInGlance: vi.fn(),
    copyText: vi.fn(),
    copyImage: vi.fn(),
    save: vi.fn(),
    savePage: vi.fn(),
    search: vi.fn(),
    lookUp: vi.fn(),
    readAloud: vi.fn(),
    readerView: vi.fn(),
    print: vi.fn(),
    inspect: vi.fn(),
    replaceMisspelling: vi.fn(),
    addToDictionary: vi.fn(),
    showEmojiPanel: vi.fn(),
    media: vi.fn(),
    addImageToChat: vi.fn(),
    addSelectionToChat: vi.fn(),
  };
}

/** Each item as Chrome would show it: its label, a role's name, or a rule. */
function shape(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) => {
    if (item.type === "separator") return "---";
    const name = item.label ?? item.role ?? "?";
    return item.enabled === false ? `${name} (disabled)` : name;
  });
}

function item(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = template.find((candidate) => candidate.label === label || candidate.role === label);
  if (found === undefined) throw new Error(`no menu item "${label}"`);
  return found;
}

function click(template: MenuItemConstructorOptions[], label: string): void {
  const found = item(template, label);
  if (found.click === undefined) throw new Error(`"${label}" has no click handler`);
  (found.click as () => void)();
}

describe("buildPageContextMenu", () => {
  it("offers Chrome's page menu when the pointer is over nothing in particular", () => {
    const menu = buildPageContextMenu(params(), state(), actions());
    expect(shape(menu)).toEqual([
      "Back",
      "Forward (disabled)",
      "Reload",
      "---",
      "Show Reader",
      "Save Page As…",
      "Print…",
      "---",
      "View Page Source",
      "Inspect",
    ]);
    expect(item(menu, "Back").accelerator).toBe("CommandOrControl+BracketLeft");
    expect(item(menu, "Reload").accelerator).toBe("CommandOrControl+R");
    expect(item(menu, "Print…").accelerator).toBe("CommandOrControl+P");
  });

  it("opens the page source as a view-source tab and saves the page under policy", () => {
    const run = actions();
    const menu = buildPageContextMenu(params(), state(), run);
    click(menu, "View Page Source");
    expect(run.openInNewTab).toHaveBeenCalledWith("view-source:https://example.com/article");
    click(menu, "Save Page As…");
    expect(run.savePage).toHaveBeenCalledOnce();

    const blocked = buildPageContextMenu(params(), state({ downloadAllowed: false, printAllowed: false }), run);
    expect(item(blocked, "Save Page As…").enabled).toBe(false);
    expect(item(blocked, "Print…").enabled).toBe(false);
    // An app page has no source worth a tab.
    const app = buildPageContextMenu(params({ pageURL: "pistachio://demo/invoices" }), state(), run);
    expect(shape(app)).not.toContain("View Page Source");
  });

  it("gives a link Chrome's link items, with Glance beside the new tab", () => {
    const run = actions();
    const menu = buildPageContextMenu(params({ linkURL: "https://example.com/next" }), state(), run);
    expect(shape(menu)).toEqual([
      "Open Link in New Tab",
      "Open Link in Glance",
      "---",
      "Save Link As…",
      "Copy Link Address",
      "---",
      "Inspect",
    ]);
    click(menu, "Open Link in New Tab");
    click(menu, "Open Link in Glance");
    click(menu, "Save Link As…");
    click(menu, "Copy Link Address");
    expect(run.openInNewTab).toHaveBeenCalledWith("https://example.com/next");
    expect(run.openInGlance).toHaveBeenCalledWith("https://example.com/next");
    expect(run.save).toHaveBeenCalledWith("https://example.com/next");
    expect(run.copyText).toHaveBeenCalledWith("https://example.com/next");
  });

  it("copies the address of a mailto link and never opens privileged links", () => {
    const run = actions();
    const mail = buildPageContextMenu(params({ linkURL: "mailto:ada%40example.com?subject=hi" }), state(), run);
    expect(shape(mail)).toEqual(["Copy Email Address", "---", "Inspect"]);
    click(mail, "Copy Email Address");
    expect(run.copyText).toHaveBeenCalledWith("ada@example.com");

    const script = buildPageContextMenu(params({ linkURL: "javascript:alert(1)" }), state(), run);
    expect(shape(script)).toEqual(expect.arrayContaining(["Back", "Reload"]));
    expect(shape(script)).not.toContain("Open Link in New Tab");
  });

  it("gives an image Chrome's image items: open, save, copy, copy address, search", () => {
    const run = actions();
    const src = "https://cdn.example.com/photo.jpg";
    const menu = buildPageContextMenu(params({ mediaType: "image", srcURL: src, hasImageContents: true }), state(), run);
    expect(shape(menu)).toEqual([
      "Open Image in New Tab",
      "Save Image As…",
      "Copy Image",
      "Copy Image Address",
      "Search Image with Google",
      "Add Image to Chat",
      "---",
      "Inspect",
    ]);
    click(menu, "Open Image in New Tab");
    click(menu, "Save Image As…");
    click(menu, "Copy Image");
    click(menu, "Copy Image Address");
    click(menu, "Search Image with Google");
    click(menu, "Add Image to Chat");
    expect(run.addImageToChat).toHaveBeenCalledOnce();
    expect(run.openInNewTab).toHaveBeenNthCalledWith(1, src);
    expect(run.save).toHaveBeenCalledWith(src);
    expect(run.copyImage).toHaveBeenCalledOnce();
    expect(run.copyText).toHaveBeenCalledWith(src);
    expect(run.openInNewTab).toHaveBeenNthCalledWith(
      2,
      `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(src)}`,
    );
  });

  it("keeps an inline image to what applies: no tab or search for a data URL, no copy before it loads", () => {
    const data = buildPageContextMenu(
      params({ mediaType: "image", srcURL: "data:image/png;base64,AAAA", hasImageContents: false }),
      state(),
      actions(),
    );
    expect(shape(data)).toEqual([
      "Save Image As…",
      "Copy Image (disabled)",
      "Copy Image Address",
      "Add Image to Chat (disabled)",
      "---",
      "Inspect",
    ]);
    const canvas = buildPageContextMenu(params({ mediaType: "canvas", hasImageContents: true }), state(), actions());
    expect(shape(canvas)).toEqual(["Copy Image", "---", "Inspect"]);
  });

  it("stacks link items above image items for a linked image", () => {
    const menu = buildPageContextMenu(
      params({ linkURL: "https://example.com/next", mediaType: "image", srcURL: "https://example.com/a.png", hasImageContents: true }),
      state(),
      actions(),
    );
    expect(shape(menu)).toEqual([
      "Open Link in New Tab",
      "Open Link in Glance",
      "---",
      "Save Link As…",
      "Copy Link Address",
      "---",
      "Open Image in New Tab",
      "Save Image As…",
      "Copy Image",
      "Copy Image Address",
      "Search Image with Google",
      "Add Image to Chat",
      "---",
      "Inspect",
    ]);
  });

  it("gives a video Chrome's playback toggles and file items, applied to that element", () => {
    const run = actions();
    const src = "https://media.example.com/clip.mp4";
    const menu = buildPageContextMenu(
      params({ mediaType: "video", srcURL: src, mediaFlags: { ...params().mediaFlags, isLooping: true } }),
      state(),
      run,
    );
    expect(shape(menu)).toEqual([
      "Loop",
      "Show Controls",
      "Picture in Picture",
      "---",
      "Save Video As…",
      "Copy Video Address",
      "Open Video in New Tab",
      "---",
      "Inspect",
    ]);
    expect(item(menu, "Loop")).toMatchObject({ type: "checkbox", checked: true });
    expect(item(menu, "Show Controls")).toMatchObject({ type: "checkbox", checked: true });
    click(menu, "Loop");
    click(menu, "Show Controls");
    click(menu, "Picture in Picture");
    expect(vi.mocked(run.media).mock.calls.map(([command]) => command)).toEqual(["loop", "controls", "pictureInPicture"]);
    click(menu, "Save Video As…");
    expect(run.save).toHaveBeenCalledWith(src);

    const audio = buildPageContextMenu(params({ mediaType: "audio", srcURL: "https://media.example.com/a.mp3" }), state(), run);
    expect(shape(audio)).toEqual([
      "Loop",
      "Show Controls",
      "---",
      "Save Audio As…",
      "Copy Audio Address",
      "Open Audio in New Tab",
      "---",
      "Inspect",
    ]);
  });

  it("names the search item after the engine the person chose", () => {
    const run = actions();
    const menu = buildPageContextMenu(params({ selectionText: "pistachio" }), state({ searchProvider: "duckduckgo" }), run);
    expect(shape(menu)).toContain("Search DuckDuckGo for “pistachio”");
    expect(shape(menu)).not.toContain("Search Google for “pistachio”");
    click(menu, "Search DuckDuckGo for “pistachio”");
    expect(run.search).toHaveBeenCalledWith("pistachio");
  });

  it("gives selected words look up, copy, search, read aloud, and print", () => {
    const run = actions();
    const selectionText = "  The quick brown fox jumps over the lazy dog again  ";
    const menu = buildPageContextMenu(params({ selectionText }), state(), run);
    expect(shape(menu)).toEqual([
      "Look Up “The quick brown fox jumps over…”",
      "---",
      "copy",
      "Search Google for “The quick brown fox jumps over…”",
      "Read Aloud",
      "Add Selection to Chat",
      "---",
      "Print…",
      "---",
      "Inspect",
    ]);
    click(menu, "Search Google for “The quick brown fox jumps over…”");
    click(menu, "Read Aloud");
    click(menu, "Add Selection to Chat");
    click(menu, "Look Up “The quick brown fox jumps over…”");
    expect(run.search).toHaveBeenCalledWith("The quick brown fox jumps over the lazy dog again");
    expect(run.readAloud).toHaveBeenCalledWith("The quick brown fox jumps over the lazy dog again");
    expect(run.addSelectionToChat).toHaveBeenCalledWith("The quick brown fox jumps over the lazy dog again");
    expect(run.lookUp).toHaveBeenCalledOnce();

    const elsewhere = buildPageContextMenu(params({ selectionText }), state({ platform: "other" }), run);
    expect(shape(elsewhere)[0]).toBe("copy");
  });

  it("holds every way words leave the page to the copy policy", () => {
    const menu = buildPageContextMenu(
      params({ selectionText: "secret", linkURL: "https://example.com/x" }),
      state({ copyAllowed: false }),
      actions(),
    );
    for (const label of ["copy", "Copy Link Address", "Look Up “secret”", "Search Google for “secret”", "Read Aloud", "Add Selection to Chat"]) {
      expect(item(menu, label).enabled, label).toBe(false);
    }
    expect(item(menu, "Open Link in New Tab").enabled).not.toBe(false);
  });

  it("gives a text field Chrome's editing menu, with each command gated by what the field allows", () => {
    const run = actions();
    const menu = buildPageContextMenu(
      params({
        isEditable: true,
        editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false },
      }),
      state(),
      run,
    );
    expect(shape(menu)).toEqual([
      "Emoji & Symbols",
      "---",
      "undo",
      "redo (disabled)",
      "---",
      "cut (disabled)",
      "copy (disabled)",
      "paste",
      "Paste as Plain Text",
      "delete (disabled)",
      "---",
      "selectAll",
      "---",
      "Inspect",
    ]);
    expect(item(menu, "Paste as Plain Text").role).toBe("pasteAndMatchStyle");
    click(menu, "Emoji & Symbols");
    expect(run.showEmojiPanel).toHaveBeenCalledOnce();

    const pasteBlocked = buildPageContextMenu(
      params({ isEditable: true, editFlags: { ...params().editFlags, canPaste: true } }),
      state({ pasteAllowed: false, platform: "other" }),
      run,
    );
    expect(shape(pasteBlocked)[0]).toBe("undo (disabled)");
    expect(item(pasteBlocked, "paste").enabled).toBe(false);
    expect(item(pasteBlocked, "Paste as Plain Text").enabled).toBe(false);
  });

  it("puts spelling suggestions first in a text field and lets a search follow the selection", () => {
    const run = actions();
    const menu = buildPageContextMenu(
      params({
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "tech"],
        selectionText: "teh",
        editFlags: { ...params().editFlags, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true },
      }),
      state({ platform: "other" }),
      run,
    );
    expect(shape(menu).slice(0, 4)).toEqual(["the", "tech", "---", "Add to Dictionary"]);
    expect(shape(menu).slice(-5)).toEqual(["Search Google for “teh”", "Read Aloud", "Add Selection to Chat", "---", "Inspect"]);
    click(menu, "tech");
    click(menu, "Add to Dictionary");
    expect(run.replaceMisspelling).toHaveBeenCalledWith("tech");
    expect(run.addToDictionary).toHaveBeenCalledWith("teh");

    const noGuess = buildPageContextMenu(
      params({ isEditable: true, misspelledWord: "xqzv", dictionarySuggestions: [] }),
      state({ platform: "other" }),
      run,
    );
    expect(shape(noGuess).slice(0, 3)).toEqual(["No Guesses Found (disabled)", "---", "Add to Dictionary"]);
  });
});

describe("menuExcerpt", () => {
  it("shortens long selections the way Chrome's labels do", () => {
    expect(menuExcerpt("short")).toBe("short");
    expect(menuExcerpt("a".repeat(32))).toBe("a".repeat(32));
    expect(menuExcerpt("word ".repeat(10))).toBe("word word word word word word w…");
    expect(menuExcerpt("many\n\n  spaces   here")).toBe("many spaces here");
  });
});

describe("pageFileName", () => {
  it("names the saved page after its title, cleaned for the file system", () => {
    expect(pageFileName("Northstar · Invoices: Q3?", "https://example.com")).toBe("Northstar · Invoices Q3");
    expect(pageFileName("  trailing dots... ", "https://example.com")).toBe("trailing dots");
    expect(pageFileName("x".repeat(140), "https://example.com")).toHaveLength(100);
  });

  it("falls back to the host, then to a generic name", () => {
    expect(pageFileName("", "https://docs.example.com/guide")).toBe("docs.example.com");
    expect(pageFileName("///", "not a url")).toBe("page");
  });
});

describe("contextMediaScript", () => {
  it("finds the element by its address in the page world and applies the command", () => {
    const script = contextMediaScript("https://m.example.com/a.mp4", "loop");
    expect(script).toContain('"https://m.example.com/a.mp4"');
    expect(script).toContain("media.loop = !media.loop");
    expect(contextMediaScript("blob:x", "pictureInPicture")).toContain("requestPictureInPicture");
    // Addresses are embedded as JSON, so a quote in one cannot escape the string.
    expect(contextMediaScript('https://x/"; alert(1); "', "controls")).toContain('\\"; alert(1); \\"');
  });
});
