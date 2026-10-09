/** Settings → General: how the sidebar behaves, what a tab does, where a search goes, and what the window opens with. */

import { Globe } from "lucide-react";
import { useState } from "react";
import { AI_SEARCH_PROVIDERS, WEB_SEARCH_PROVIDERS, aiSearchLabel, webSearchLabel } from "@pistachio/shell-contracts/search";
import { effectiveSidebarMode, type SidebarMode } from "@pistachio/shell-contracts/settings";
import { isAllowedNavigation, withScheme as withSchemeForHost } from "@pistachio/shell-contracts/url";
import { runShellCommand } from "../../../chrome/shell-host";
import { briefTimeItems } from "../../../lib/reports";
import { isProbablyUrl } from "../../../lib/url";
import { useAppStore } from "../../../store";
import { useSurface } from "../../../surface";
import { SearchProviderLogo } from "../../SearchProviderLogo";
import { IconSelect } from "../../ui/icon-select";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Group, Page, Row } from "../parts";

const NEW_TAB_ITEMS = [
  { value: "home", label: "Home page" },
  { value: "address", label: "Address bar" },
  { value: "url", label: "A page" },
] as const;

const WEB_SEARCH_ITEMS = WEB_SEARCH_PROVIDERS.map(({ id, label }) => ({ value: id, label, icon: <SearchProviderLogo provider={id} /> }));
const AI_SEARCH_ITEMS = AI_SEARCH_PROVIDERS.map(({ id, label }) => ({ value: id, label, icon: <SearchProviderLogo provider={id} /> }));

/** The sidebar's modes (docs/spaces.md §3). The rail is the desktop's alone: its pieces need the desk. */
const SIDEBAR_ITEMS: ReadonlyArray<{ value: SidebarMode; label: string }> = [
  { value: "whole", label: "Whole" },
  { value: "rail", label: "Rail — icons only" },
  { value: "hidden", label: "Hidden — reveal at the left edge" },
];
const WEB_SIDEBAR_ITEMS = SIDEBAR_ITEMS.filter((item) => item.value !== "rail");

/**
 * An address a setting stores. Committed on Enter/blur rather than per
 * keystroke — a half-typed address is not a setting. `commit` receives the
 * trimmed draft and answers with a problem to show, or null when it took.
 */
function AddressRow({
  label,
  note,
  ariaLabel,
  placeholder,
  configured,
  commit,
}: {
  label: string;
  note: string;
  ariaLabel: string;
  placeholder: string;
  configured: string;
  commit: (raw: string) => string | null;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const onCommit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === configured) return;
    setProblem(commit(raw));
  };

  return (
    <Row label={label} note={note}>
      <Input
        type="text"
        spellCheck={false}
        autoComplete="off"
        aria-label={ariaLabel}
        error={problem}
        placeholder={placeholder}
        prefix={<Globe aria-hidden="true" />}
        value={draft ?? configured}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          }
        }}
        containerClassName="w-60 @max-md:w-40"
        className="w-full"
        inputClassName="font-mono placeholder:font-sans"
      />
    </Row>
  );
}

/** Bare input gets a scheme the way the address bar would give it. */
function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : withSchemeForHost(raw);
}

/**
 * The page ⌘T opens. Anything that is not a web address is refused out loud
 * instead of quietly stored and ignored at open time.
 */
function NewTabPageRow() {
  const configured = useAppStore((s) => s.settings.general.newTabUrl);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <AddressRow
      label="Page for new tabs"
      note="Where ⌘T lands when it opens a page. Empty means the home page opens instead."
      ariaLabel="New tab page"
      placeholder="app.example.com"
      configured={configured}
      commit={(raw) => {
        if (raw.length === 0) {
          void updateSettings({ general: { newTab: "home", newTabUrl: "" } });
          return null;
        }
        const url = withScheme(raw);
        if (!isProbablyUrl(raw) || !/^https?:\/\//i.test(url)) {
          return "A new tab page has to be a web address, like app.example.com.";
        }
        void updateSettings({ general: { newTab: "url", newTabUrl: url } });
        return null;
      }}
    />
  );
}

/**
 * The page a tab shows when nothing chose one: the first tab of a window or
 * a Space, and the empty pane of a split. Empty is Pistachio's own home page
 * (@pistachio/shell-contracts/home); the app's own pages (the demo portal)
 * are allowed alongside the web so a person can put the demo back.
 */
function HomePageRow() {
  const general = useAppStore((s) => s.settings.general);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const configured = general.homePage === "url" ? general.homeUrl : "";

  return (
    <AddressRow
      label="Home page"
      note="What a new window or Profile opens with, and where an empty split pane starts. Empty is Pistachio's home page."
      ariaLabel="Home page"
      placeholder="Pistachio home"
      configured={configured}
      commit={(raw) => {
        if (raw.length === 0) {
          void updateSettings({ general: { homePage: "pistachio" } });
          return null;
        }
        const url = withScheme(raw);
        if (!isProbablyUrl(raw) || !isAllowedNavigation(url)) {
          return "A home page has to be a web address, like www.google.com.";
        }
        void updateSettings({ general: { homePage: "url", homeUrl: url } });
        return null;
      }}
    />
  );
}

export function GeneralPage() {
  const native = useSurface().kind === "native";
  const stored = useAppStore((s) => s.settings.layout.sidebar);
  // A rail stored where none is offered (the web) shows as what is drawn: the whole sidebar.
  const sidebar = effectiveSidebarMode(stored, native);
  const general = useAppStore((s) => s.settings.general);
  const search = useAppStore((s) => s.settings.search);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <Page
      title="General"
      description="How the sidebar behaves, how tabs open, and what the window looks like when it does."
    >
      <Group title="Sidebar" note="Your tabs and the browser's controls live in a column at the window's left edge.">
        <Row
          label="Sidebar visibility"
          note={
            native
              ? "Whole keeps the sidebar beside the desk; Rail keeps its icons alone. Hidden puts the sidebar and the window controls away: move the pointer to the left edge, and it comes out over the desk. ⌘S goes from one to the next."
              : "Hidden puts the sidebar and the window controls away. Move the pointer to the left edge to bring them back. ⌘S switches between whole and hidden."
          }
        >
          <Select
            aria-label="Sidebar visibility"
            data-testid="sidebar-presentation"
            value={sidebar}
            items={native ? SIDEBAR_ITEMS : WEB_SIDEBAR_ITEMS}
            onValueChange={(mode) => runShellCommand({ type: "setSidebarMode", mode })}
            className="w-55 @max-md:w-42"
          />
        </Row>
      </Group>

      <Group
        title="New tabs"
        note={native ? "What it costs to close a tab the agent is working in." : "What ⌘T does, and what it costs to close a tab the agent is working in."}
      >
        {/* (Not on the desktop: ⌘T there always opens a home window in the current space, docs/spaces.md §1.) */}
        {native ? null : (
          <>
            <Row label="New tabs open" note="⌘T can open your home page, ask for an address every time, or go straight to a page you name below.">
              <Select
                aria-label="New tab behavior"
                value={general.newTab}
                items={NEW_TAB_ITEMS}
                onValueChange={(newTab) => void updateSettings({ general: { newTab } })}
                className="w-35"
              />
            </Row>
            <NewTabPageRow />
          </>
        )}
        <Row
          label="Ask before closing a tab with a live run"
          note="Closing the tab the agent is using ends the browser task. A confirmation keeps ⌘W from stopping work by accident."
        >
          <Switch
            checked={general.confirmCloseWithRun}
            label="Confirm before closing a tab with a live run"
            onChange={(confirmCloseWithRun) => void updateSettings({ general: { confirmCloseWithRun } })}
          />
        </Row>
      </Group>

      <Group title="Search" note="Where the words you type into the address bar go. It offers both for anything you type.">
        <Row
          label="Web search"
          note={`Typing words and pressing ↵ searches ${webSearchLabel(search.webProvider)}. A page's “Search for” menu item uses it too.`}
        >
          <IconSelect
            aria-label="Web search provider"
            data-testid="web-search-provider"
            value={search.webProvider}
            items={WEB_SEARCH_ITEMS}
            onValueChange={(webProvider) => void updateSettings({ search: { webProvider } })}
            className="w-44"
          />
        </Row>
        <Row
          label="AI search"
          note={`The address bar's “Ask ${aiSearchLabel(search.aiProvider)}” suggestion opens a new conversation there with what you typed as the prompt.`}
        >
          <IconSelect
            aria-label="AI search provider"
            data-testid="ai-search-provider"
            value={search.aiProvider}
            items={AI_SEARCH_ITEMS}
            onValueChange={(aiProvider) => void updateSettings({ search: { aiProvider } })}
            className="w-44"
          />
        </Row>
        <Row
          label="Smart suggestions"
          note="The address bar puts the likeliest row first — a page, a setting, a search, a prompt. What you type goes to a fast intent model as you type it, with the titles of a few recent pages; addresses are never sent."
        >
          <Switch
            checked={search.smartSuggestions}
            label="Smart suggestions"
            onChange={(smartSuggestions) => void updateSettings({ search: { smartSuggestions } })}
          />
        </Row>
        <Row
          label="Find by meaning"
          note="Find in page can take a description instead of exact words and land on the passage that means it. Only when you ask: the page's visible text and your description go to a fast evaluation model. An exact find never sends anything."
        >
          <Switch
            checked={search.smartFind}
            label="Find by meaning"
            onChange={(smartFind) => void updateSettings({ search: { smartFind } })}
          />
        </Row>
      </Group>

      <Group title="Window" note="What the window opens with.">
        <HomePageRow />
        <Row
          label="Open the agent chat on launch"
          note="Show the conversation beside the page when Pistachio starts. ⌘I toggles it at any time."
        >
          <Switch
            checked={general.consoleOpenOnLaunch}
            label="Open the agent chat on launch"
            onChange={(consoleOpenOnLaunch) => void updateSettings({ general: { consoleOpenOnLaunch } })}
          />
        </Row>
        <Row
          label="Prepare my daily brief each morning"
          note="Put the brief together from your calendar, mail and to-dos at a set time, so it is ready before you ask. If Pistachio is closed or asleep then, it is made as soon as it is back. Off, the brief is made when you open it."
        >
          <Switch
            checked={general.morningBrief}
            label="Prepare my daily brief each morning"
            onChange={(morningBrief) => void updateSettings({ general: { morningBrief } })}
          />
        </Row>
        {general.morningBrief ? (
          <>
            <Row label="Ready by" note="Your local time.">
              <Select
                aria-label="Daily brief time"
                value={general.morningBriefTime}
                items={briefTimeItems(general.morningBriefTime)}
                onValueChange={(morningBriefTime) => void updateSettings({ general: { morningBriefTime } })}
                className="w-35"
              />
            </Row>
            <Row label="Notify me when it is ready" note="A system notification when Pistachio is not in front; a note in the window when it is.">
              <Switch
                checked={general.morningBriefNotify}
                label="Notify me when the daily brief is ready"
                onChange={(morningBriefNotify) => void updateSettings({ general: { morningBriefNotify } })}
              />
            </Row>
          </>
        ) : null}
      </Group>
    </Page>
  );
}
