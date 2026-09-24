/**
 * The settings page (⌘,): a rail of sections and a scrolling content column,
 * painted over the content hole.
 *
 * Rendered by the CHROME renderer into the browser surface, not by a document
 * in a WebContents of its own. The tab WebContentsViews sit ABOVE the chrome,
 * so this surface is invisible until main raises the chrome — which is what
 * `overlay: "settings"` does through the store's overlay reporting (the same
 * mechanism the address bar uses). It paints its own opaque surface, because
 * the pane it fills is showing a still of the page underneath.
 *
 * `@container`, not viewport breakpoints: the page shares the window with the
 * agent chat, so its layout answers to the pane it is in. Below @md
 * the rail keeps working as an icon-only strip.
 */

import { useEffect } from "react";
import { X } from "lucide-react";
import { SETTINGS_SECTIONS, type SettingsSection } from "@pistachio/shell-contracts/settings";
import { copyFor } from "../../lib/surface-copy";
import { useAppStore } from "../../store";
import { useSurface } from "../../surface";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { SETTINGS_DIALOG_HOST_ID } from "./dialogs";
import { SettingsNav } from "./SettingsNav";
import { AboutPage } from "./sections/about";
import { AccountPage } from "./sections/account";
import { ApprovalsPage } from "./sections/approvals";
import { AppearancePage } from "./sections/appearance";
import { BookmarksSettingsPage } from "./sections/bookmarks";
import { WatchtowerSettingsPage } from "./sections/watchtower";
import { CloudPage } from "./sections/cloud";
import { DelegationPage } from "./sections/delegation";
import { DevicesPage } from "./sections/devices";
import { EgressPage } from "./sections/egress";
import { EvidencePage } from "./sections/evidence";
import { GeneralPage } from "./sections/general";
import { IntegrationsPage } from "./sections/integrations";
import { MemoryPage } from "./sections/memory";
import { IsolationPage, SiteDataPage, SpacesPage } from "./sections/privacy";
import { RemindersSettingsPage } from "./sections/reminders";
import { ShortcutsPage } from "./sections/shortcuts";
import { SyncPage } from "./sections/sync";
import { TabsSettingsPage } from "./sections/tabs";
import { VaultPage } from "./sections/vault";

const PAGES: Record<SettingsSection, () => React.ReactElement> = {
  "": GeneralPage,
  appearance: AppearancePage,
  tabs: TabsSettingsPage,
  delegation: DelegationPage,
  memory: MemoryPage,
  reminders: RemindersSettingsPage,
  bookmarks: BookmarksSettingsPage,
  watchtower: WatchtowerSettingsPage,
  integrations: IntegrationsPage,
  approvals: ApprovalsPage,
  evidence: EvidencePage,
  privacy: SiteDataPage,
  "privacy/spaces": SpacesPage,
  "privacy/isolation": IsolationPage,
  account: AccountPage,
  devices: DevicesPage,
  sync: SyncPage,
  cloud: CloudPage,
  egress: EgressPage,
  vault: VaultPage,
  shortcuts: ShortcutsPage,
  about: AboutPage,
};

export function SettingsPage() {
  const section = useAppStore((s) => s.settingsSection);
  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const Section = PAGES[section];
  const copy = copyFor(useSurface().kind);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  return (
    <div
      role="dialog"
      aria-label="Settings"
      data-testid="settings-page"
      className="@container animate-backdrop-in absolute inset-0 z-20 flex overflow-hidden rounded-md bg-background-100 shadow-small"
    >
      <aside className="flex w-[214px] shrink-0 flex-col border-r border-alpha-400 bg-background-200 @max-md:w-[46px] @max-xl:w-[186px]">
        <header className="flex shrink-0 items-center gap-2.5 px-3 pt-4 pb-2.5 @max-md:justify-center @max-md:px-0">
          <Avatar size={24} className="shadow-none">
            <AvatarFallback className="bg-green-700 text-white">P</AvatarFallback>
          </Avatar>
          <span className="min-w-0 @max-md:hidden">
            <span className="block text-heading-14 text-gray-1000">Settings</span>
            <span className="block truncate text-[10.5px] leading-4 text-gray-700">{copy.settings.lede}</span>
          </span>
        </header>
        <SettingsNav section={section} onNavigate={openSettings} />
      </aside>
      {/* min-w-0 so a long unbroken string in a section cannot push the rail
          off the pane; the scroller is the content column, not the page. */}
      <main className="relative min-w-0 flex-1">
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          <Kbd className="@max-md:hidden">esc</Kbd>
          <Button variant="tertiary" size="sm" svgOnly aria-label="Close settings" onClick={closeSettings}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {/* scrollbar-gutter keeps the column in the same place whether or not
            the section is tall enough to scroll, so switching sections never
            nudges the title sideways. */}
        <div className="scroll-thin h-full overflow-y-auto [scrollbar-gutter:stable]" key={section}>
          <Section />
        </div>
      </main>
      {/* The layer a section's confirmation sheets are portalled into: at the
          page's own root, so a dialog raised inside a fieldset is clipped by
          neither the card nor the content column's scroller. Empty and
          transparent to the pointer until one is up. */}
      <div id={SETTINGS_DIALOG_HOST_ID} className="pointer-events-none absolute inset-0 z-30" />
      <span className="sr-only">{SETTINGS_SECTIONS[section]}</span>
    </div>
  );
}
