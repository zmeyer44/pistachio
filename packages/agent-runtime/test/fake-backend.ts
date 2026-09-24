/**
 * An in-memory `BrowserBackend` that serves the contract's fixture page at
 * every URL and models its behaviour — the toggle, the form that submits
 * on Enter, the typeahead that opens on real keystrokes — so the contract
 * suite itself is exercised without a browser. The real runs are the
 * desktop's (Electron) and the cloud browser's (Playwright).
 */

import type { AgentPressableKey } from "@pistachio/protocol";
import type { AgentTabInfo, BrowserBackend, PageControl, PageInspection } from "../src/index.js";

/** A 1×1 transparent PNG. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface FixtureState {
  query: string;
  notes: string;
  editor: string;
  typeahead: string;
  status: string;
  suggestionsOpen: boolean;
  focused: string | null;
}

function freshState(): FixtureState {
  return { query: "", notes: "", editor: "", typeahead: "", status: "idle", suggestionsOpen: false, focused: null };
}

interface TextNode {
  kind: "text";
  text: string;
}

interface ControlNode {
  kind: "control";
  id: string;
  role: string;
  name: string;
  /** What the element contributes to the page's rendered text. */
  text: string;
  type: string | null;
  href: string | null;
  /** Non-null for controls that hold a value the agent can type into. */
  value: string | null;
  editable: boolean;
  /** Matches the click-by-label candidate list of `clickPageScript`. */
  clickable: boolean;
  /** What `typePrepareScript` matches a label against: aria-label, placeholder, name, id. */
  labels: string[];
}

type FixtureNode = TextNode | ControlNode;

function text(value: string): TextNode {
  return { kind: "text", text: value };
}

function control(
  fields: Pick<ControlNode, "id" | "role" | "name"> & Partial<Omit<ControlNode, "kind" | "id" | "role" | "name">>,
): ControlNode {
  return {
    kind: "control",
    text: "",
    type: null,
    href: null,
    value: null,
    editable: false,
    clickable: false,
    labels: [fields.id],
    ...fields,
  };
}

/** The fixture's DOM, in document order, as the page currently stands. */
function fixtureNodes(state: FixtureState): FixtureNode[] {
  return [
    text("Backend fixture"),
    text("A page for the browser backend contract."),
    control({ id: "query", role: "input", name: "Search", type: "text", value: state.query, editable: true, labels: ["Search", "q", "query"] }),
    control({ id: "go", role: "button", name: "Go", text: "Go", clickable: true }),
    control({ id: "notes", role: "textarea", name: "Notes", value: state.notes, editable: true, labels: ["Notes", "notes"] }),
    control({ id: "editor", role: "textbox", name: "Editor", text: state.editor, value: state.editor, editable: true, labels: ["Editor", "editor"] }),
    control({ id: "typeahead", role: "input", name: "Typeahead", type: "text", value: state.typeahead, editable: true, labels: ["Typeahead", "typeahead"] }),
    ...(state.suggestionsOpen
      ? [
          control({ id: "suggestion-1", role: "option", name: "Suggestion one", text: "Suggestion one", clickable: true }),
          control({ id: "suggestion-2", role: "option", name: "Suggestion two", text: "Suggestion two", clickable: true }),
        ]
      : []),
    control({ id: "toggle", role: "button", name: "Toggle", text: "Toggle", clickable: true }),
    text(state.status),
    control({ id: "link", role: "a", name: "Next page", text: "Next page", href: "https://example.com/next", clickable: true }),
  ];
}

interface FakeTab {
  id: string;
  history: string[];
  index: number;
  state: FixtureState;
}

function isFixture(url: string): boolean {
  return url !== "about:blank";
}

export class FakeBrowserBackend implements BrowserBackend {
  readonly kind: "desktop" | "cloud";
  readonly #tabs = new Map<string, FakeTab>();
  #next = 0;
  #active: string | null = null;

  constructor(kind: "desktop" | "cloud" = "desktop") {
    this.kind = kind;
  }

  listTabs(): AgentTabInfo[] {
    return [...this.#tabs.values()].map((tab) => ({
      id: tab.id,
      spaceId: "work",
      title: isFixture(this.#url(tab)) ? "Backend fixture" : "",
      url: this.#url(tab),
      loading: false,
      canGoBack: tab.index > 0,
      canGoForward: tab.index < tab.history.length - 1,
      kind: "agent",
    }));
  }

  async openTab(url?: string): Promise<string> {
    const id = `fake:${String(++this.#next)}`;
    this.#tabs.set(id, { id, history: [url ?? "about:blank"], index: 0, state: freshState() });
    this.#active = id;
    return id;
  }

  async focusTab(tabId: string): Promise<void> {
    this.#tab(tabId);
    this.#active = tabId;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.#tab(tabId);
    tab.history = [...tab.history.slice(0, tab.index + 1), new URL(url).href];
    tab.index = tab.history.length - 1;
    tab.state = freshState();
  }

  async back(tabId: string): Promise<void> {
    const tab = this.#tab(tabId);
    if (tab.index === 0) return;
    tab.index -= 1;
    tab.state = freshState();
  }

  async forward(tabId: string): Promise<void> {
    const tab = this.#tab(tabId);
    if (tab.index >= tab.history.length - 1) return;
    tab.index += 1;
    tab.state = freshState();
  }

  async reload(tabId: string): Promise<void> {
    this.#tab(tabId).state = freshState();
  }

  async inspect(tabId: string): Promise<PageInspection> {
    const tab = this.#tab(tabId);
    const url = this.#url(tab);
    if (!isFixture(url)) return { title: "", url, text: "", controls: [] };
    const nodes = fixtureNodes(tab.state);
    const controls: PageControl[] = [];
    const words: string[] = [];
    for (const node of nodes) {
      if (node.text !== "") words.push(node.text);
      if (node.kind !== "control") continue;
      controls.push({
        role: node.role,
        name: node.name,
        selector: `#${node.id}`,
        href: node.href,
        type: node.type,
        value: node.value,
        disabled: false,
      });
    }
    return { title: "Backend fixture", url, text: words.join(" "), controls };
  }

  async click(tabId: string, target: string): Promise<void> {
    const tab = this.#tab(tabId);
    const nodes = isFixture(this.#url(tab)) ? this.#controls(tab) : [];
    const found =
      (target.startsWith("#") ? nodes.find((node) => node.id === target.slice(1)) : undefined) ??
      nodes.find((node) => node.clickable && node.name.toLowerCase().includes(target.trim().toLowerCase()));
    if (found === undefined) throw new Error(`page control not found: ${target}`);
    tab.state.focused = found.id;
    switch (found.id) {
      case "go":
        this.#submit(tab);
        break;
      case "toggle":
        tab.state.status = tab.state.status === "toggled" ? "idle" : "toggled";
        break;
      case "link":
        await this.navigate(tabId, found.href ?? "about:blank");
        break;
      default:
        if (found.role === "option") {
          tab.state.typeahead = found.name;
          tab.state.suggestionsOpen = false;
        }
    }
  }

  async type(tabId: string, target: string, value: string): Promise<string> {
    const tab = this.#tab(tabId);
    const editable = (isFixture(this.#url(tab)) ? this.#controls(tab) : []).filter((node) => node.editable);
    const normalized = target.trim().toLowerCase();
    const found =
      (target.startsWith("#") ? editable.find((node) => node.id === target.slice(1)) : undefined) ??
      editable.find((node) => node.labels.some((label) => label.toLowerCase().includes(normalized)));
    if (found === undefined) throw new Error(`editable page control not found: ${target}`);
    tab.state.focused = found.id;
    switch (found.id) {
      case "query":
        tab.state.query = value;
        break;
      case "notes":
        tab.state.notes = value;
        break;
      case "editor":
        tab.state.editor = value;
        break;
      case "typeahead":
        tab.state.typeahead = value;
        // Real keystrokes: the page's trusted-keydown listener opens the list.
        if (value !== "") tab.state.suggestionsOpen = true;
        break;
    }
    return value;
  }

  async press(tabId: string, key: AgentPressableKey): Promise<void> {
    const tab = this.#tab(tabId);
    if (key === "Enter" && (tab.state.focused === "query" || tab.state.focused === "go")) this.#submit(tab);
    if (key === "Escape") tab.state.suggestionsOpen = false;
  }

  async scroll(tabId: string, _deltaY: number): Promise<void> {
    this.#tab(tabId);
  }

  async screenshot(tabId: string): Promise<string> {
    this.#tab(tabId);
    return PNG_DATA_URL;
  }

  get activeTabId(): string | null {
    return this.#active;
  }

  #submit(tab: FakeTab): void {
    tab.state.status = `submitted ${tab.state.query}`;
  }

  #controls(tab: FakeTab): ControlNode[] {
    return fixtureNodes(tab.state).filter((node): node is ControlNode => node.kind === "control");
  }

  #url(tab: FakeTab): string {
    return tab.history[tab.index] ?? "about:blank";
  }

  #tab(tabId: string): FakeTab {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error(`unknown tab: ${tabId}`);
    return tab;
  }
}
