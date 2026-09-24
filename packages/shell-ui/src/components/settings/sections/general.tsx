/** Settings → General: where the chrome lives, what a tab does, where a search goes, and what the window opens with. */

import { Globe } from "lucide-react";
import { useRef, useState } from "react";
import { AI_SEARCH_PROVIDERS, WEB_SEARCH_PROVIDERS, aiSearchLabel, webSearchLabel } from "@pistachio/shell-contracts/search";
import { CHROME_LAYOUT_MODES, type ChromeLayoutMode, type SidebarPresentation } from "@pistachio/shell-contracts/settings";
import { isAllowedNavigation, withScheme as withSchemeForHost } from "@pistachio/shell-contracts/url";
import { cn } from "../../../lib/cn";
import { briefTimeItems } from "../../../lib/reports";
import { isProbablyUrl } from "../../../lib/url";
import { useAppStore } from "../../../store";
import { SearchProviderLogo } from "../../SearchProviderLogo";
import { IconSelect } from "../../ui/icon-select";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Block, Group, Page, Row } from "../parts";

const NEW_TAB_ITEMS = [
  { value: "home", label: "Home page" },
  { value: "address", label: "Address bar" },
  { value: "url", label: "A page" },
] as const;

const WEB_SEARCH_ITEMS = WEB_SEARCH_PROVIDERS.map(({ id, label }) => ({ value: id, label, icon: <SearchProviderLogo provider={id} /> }));
const AI_SEARCH_ITEMS = AI_SEARCH_PROVIDERS.map(({ id, label }) => ({ value: id, label, icon: <SearchProviderLogo provider={id} /> }));

const SIDEBAR_ITEMS: ReadonlyArray<{ value: SidebarPresentation; label: string }> = [
  { value: "pinned", label: "Always visible" },
  { value: "compact", label: "Compact — reveal on hover" },
];

const LAYOUT_LABELS: Record<ChromeLayoutMode, string> = {
  top: "Top tabs",
  sidebar: "Sidebar",
};

/**
 * A wireframe of the window in each layout, drawn at the size of a large
 * icon: the window frame in the recessed strip colour, the page as a card
 * inside it, and the chrome where it would be. Both frames share the traffic
 * lights so the eye reads them as the same window arranged two ways.
 */
const WIREFRAME: Record<ChromeLayoutMode, React.ReactNode> = {
  top: (
    <>
      <rect x={24.5} y={4.5} width={26} height={10} rx={2.5} className="fill-background-100 stroke-gray-500" />
      <rect x={53.5} y={4.5} width={22} height={10} rx={2.5} className="fill-none stroke-gray-500" />
      <rect x={78.5} y={4.5} width={22} height={10} rx={2.5} className="fill-none stroke-gray-500" />
      <rect x={4.5} y={18.5} width={103} height={49} rx={3} className="fill-background-100 stroke-gray-500" />
    </>
  ),
  sidebar: (
    <>
      <rect x={5.5} y={18.5} width={23} height={6} rx={1.5} className="fill-background-100 stroke-gray-500" />
      <rect x={5.5} y={27.5} width={23} height={6} rx={1.5} className="fill-none stroke-gray-500" />
      <rect x={5.5} y={36.5} width={23} height={6} rx={1.5} className="fill-none stroke-gray-500" />
      <rect x={5.5} y={45.5} width={23} height={6} rx={1.5} className="fill-none stroke-gray-500" />
      <rect x={34.5} y={4.5} width={73} height={63} rx={3} className="fill-background-100 stroke-gray-500" />
    </>
  ),
};

function LayoutWireframe({ mode }: { mode: ChromeLayoutMode }) {
  return (
    <svg width={112} height={72} viewBox="0 0 112 72" aria-hidden="true" className="block">
      <rect x={0.5} y={0.5} width={111} height={71} rx={4} className="fill-background-200 stroke-gray-500" />
      <circle cx={8} cy={8.5} r={1.5} className="fill-gray-500" />
      <circle cx={13} cy={8.5} r={1.5} className="fill-gray-500" />
      <circle cx={18} cy={8.5} r={1.5} className="fill-gray-500" />
      {WIREFRAME[mode]}
    </svg>
  );
}

/**
 * The layout choice as two illustrated radio cards. A native radio group
 * pattern on buttons: one tab stop (the checked card), arrows move the check
 * to the neighbour and follow it with focus, and Space/Enter re-affirm the
 * focused card through the button's own activation. Selected = the same
 * high-contrast ring the Switch fills with when it is on.
 */
function LayoutPicker({ mode, onChange }: { mode: ChromeLayoutMode; onChange: (mode: ChromeLayoutMode) => void }) {
  const cards = useRef<Partial<Record<ChromeLayoutMode, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, from: ChromeLayoutMode) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const count = CHROME_LAYOUT_MODES.length;
    const next = CHROME_LAYOUT_MODES[(CHROME_LAYOUT_MODES.indexOf(from) + step + count) % count];
    if (next === undefined || next === from) return;
    onChange(next);
    cards.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Tabs layout" className="flex flex-wrap gap-3">
      {CHROME_LAYOUT_MODES.map((candidate) => {
        const selected = candidate === mode;
        return (
          <button
            key={candidate}
            ref={(el) => {
              cards.current[candidate] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`layout-mode-${candidate}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(candidate)}
            onKeyDown={(event) => onKeyDown(event, candidate)}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-md bg-background-100 px-3 pt-3 pb-2.5 outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              selected
                ? "shadow-[0_0_0_1.5px_var(--color-gray-1000)]"
                : "shadow-border hover:shadow-[0_0_0_1px_var(--color-gray-500)]",
            )}
          >
            <LayoutWireframe mode={candidate} />
            <span className={cn("text-label-12", selected ? "font-medium text-gray-1000" : "text-gray-900")}>
              {LAYOUT_LABELS[candidate]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

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
      note="What a new window or Space opens with, and where an empty split pane starts. Empty is Pistachio's home page."
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
  const layout = useAppStore((s) => s.settings.layout);
  const general = useAppStore((s) => s.settings.general);
  const search = useAppStore((s) => s.settings.search);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <Page
      title="General"
      description="Where the tabs live, how they open, and what the window looks like when it does."
    >
      <Group
        title="Tabs layout"
        note="Where your tabs live. The sidebar keeps every control the top row has."
      >
        <Block>
          <LayoutPicker mode={layout.mode} onChange={(mode) => void updateSettings({ layout: { mode } })} />
        </Block>
        <Row
          label="Sidebar visibility"
          note="Compact hides the sidebar and the window controls. Move the pointer to the left edge to bring them back. ⌘S switches between the two."
        >
          <Select
            aria-label="Sidebar visibility"
            data-testid="sidebar-presentation"
            value={layout.sidebar}
            items={SIDEBAR_ITEMS}
            disabled={layout.mode !== "sidebar"}
            onValueChange={(sidebar) => void updateSettings({ layout: { sidebar } })}
            className="w-55 @max-md:w-42"
          />
        </Row>
      </Group>

      <Group title="New tabs" note="What ⌘T does, and what it costs to close a tab the agent is working in.">
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
