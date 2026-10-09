/**
 * Which desktop e2e tests a changed file can break: the map
 * scripts/test-changed.mjs reads to run only the tests a change concerns.
 *
 * Every e2e test carries one or more area tags (`{ tag: ["@desk"] }`), and
 * each area below lists the source it stands on. A changed file runs every
 * area whose paths match it; a spec or e2e helper that changed runs itself
 * (and the specs that import it). A few tests also carry `@smoke` — one
 * quick pass over each part of the window — and run whenever any desktop
 * code changed, so a change is never tested by its own area alone.
 *
 * Some files are under every area at once: the browser controller, main's
 * entry, the preloads, the shell's store and frame. Those are HUB paths:
 * a change there runs the smoke tests, not the whole suite, and the whole
 * suite (`pnpm test:e2e`) is the check before merging. Desktop code that no
 * area claims counts as a hub, so new files are tested by smoke until an
 * area takes them.
 *
 * Globs: `**` crosses folders, `*` does not, `{a,b}` is either.
 */

const UI = "packages/shell-ui/src";
const C = "packages/shell-contracts/src";
const M = "apps/desktop/src/main";

/** @type {ReadonlyArray<{ tag: string; paths: readonly string[] }>} */
export const AREAS = [
  {
    // The desk: since 2026-10-09 the desktop's surface, always up (docs/spaces.md). Its mount and its store are hub
    // paths below — every desktop spec stands on them; these are its own parts. The drag layer, the window's page
    // placeholder and main's chrome views (notch, shelf, PiP, drag) were the split's; they are the desk's now.
    tag: "@desk",
    paths: [
      `${UI}/components/desk/**`,
      `${UI}/lib/desk/**`,
      `${UI}/components/{RailFavorites,PanePlaceholder}.tsx`,
      `${UI}/{NotchApp,ShelfApp,PipApp,DragApp}.tsx`,
      `${UI}/lib/{dictation,recorder,pane-drag}.ts`,
      `${C}/desk*.ts`,
      `${M}/{desk-bridge,desk-conversations,desk-layout,desk-scope,group-context-store,document-convert,chrome-view,spaces}.ts`,
      "packages/documents/**",
    ],
  },
  {
    tag: "@sidebar",
    paths: [
      `${UI}/layouts/**`,
      `${UI}/chrome/**`,
      `${UI}/components/{SidebarChrome,SidebarEdge,SidebarMenu,TabList,TabGroupRow,FavoritesGrid,ContextMenu,BrandTile}.tsx`,
      `${UI}/components/sidebar-rail.ts`,
      `${UI}/lib/{sidebar,sidebar-mode,sidebar-tree,tab-selection,chrome-tabs,chrome-status}.ts`,
      `${C}/{sidebar,sidebar-controller,chrome,page-context-menu}.ts`,
      `${M}/{sidebar-store,pointer-zone-watch,page-context-menu}.ts`,
    ],
  },
  {
    tag: "@tabs",
    paths: [
      `${UI}/components/{TabSwitcher,SpaceForkDialog}.tsx`,
      `${UI}/components/archive/**`,
      `${UI}/lib/tab-switcher-grid.ts`,
      `${C}/{tab-switcher,tab-groups,tab-archive,tidy,tab-session,spaces,page-resume}.ts`,
      `${M}/{tab-tidy,tab-archive-store,tab-session-store,space-store,forced-focus,debugger-hold}.ts`,
    ],
  },
  {
    tag: "@address",
    paths: [
      `${UI}/components/{UrlBar,address-palette,SearchProviderLogo}.tsx`,
      `${UI}/lib/{fuzzy,destination,search-suggestions,intent-ranking,use-address-intent,use-field-preview,recents,settings-intents,action-intents,url}.ts`,
      `${C}/{address-intent,search,url,page-link}.ts`,
      `${M}/address-intent.ts`,
    ],
  },
  {
    tag: "@home",
    paths: [`${UI}/components/home/**`, `${UI}/lib/{home,weather}.ts`, `${C}/{home,shell-pages}.ts`],
  },
  {
    tag: "@glance",
    paths: [`${UI}/components/{GlanceOverlay,ImagePreview}.tsx`, `${UI}/lib/glance.ts`],
  },
  {
    tag: "@agent",
    paths: [
      `${UI}/components/{AgentConsole,ThreadList,MessageText,OutputCard,FeedbackPopover,TakeoverCard,PanelShell,StatusDot,ResizeHandle}.tsx`,
      `${UI}/components/{useAgentTab,chat-*}.ts`,
      `${UI}/components/chat/**`,
      `${UI}/lib/{chat-attachments,chat-sources,run,linkify,markdown,smooth-text,panel,share}.ts`,
      `${C}/{chat-insert,run-fold,agent-glow,memory,artifacts,read-aloud}.ts`,
      `${M}/{run-controller,model-provider,scripted-agent-model,agent-browser-tools,thread-store,memory-engine,memory-store,artifact-builder,artifact-store,chat-attach,feedback,read-aloud,capsule-broker,demo-page}.ts`,
      "packages/{agent-runtime,protocol,runtime,evidence,adapters,run-view}/**",
    ],
  },
  {
    tag: "@settings",
    paths: [
      `${UI}/components/settings/**`,
      `${UI}/components/update-prompt/**`,
      `${UI}/components/UpdatePill.tsx`,
      `${UI}/lib/{settings-fit,about-rows,account,account-link,brand-colors,update-prompt}.ts`,
      `${UI}/theme/**`,
      `${UI}/theme.css`,
      `${C}/{settings,appearance,shortcuts,updates,brand-colors}.ts`,
      `${M}/{settings-store,update-service,desktop-icon,app-icon}.ts`,
      `${M}/account/**`,
    ],
  },
  {
    tag: "@onboarding",
    paths: [
      `${UI}/components/onboarding/**`,
      `${UI}/lib/onboarding-steps.ts`,
      `${C}/{onboarding,welcome-pages,browser-import}.ts`,
      `${M}/{onboarding,welcome-pages,browser-import}.ts`,
    ],
  },
  {
    tag: "@site",
    paths: [
      `${UI}/components/{SiteInfoPopover,SiteControlsPanel,PermissionPromptDialog,BrowserStatus,permission-meta}.tsx`,
      `${UI}/lib/{permission-prompt,egress}.ts`,
      `${C}/{shields,shields-page,browser-controls,private-network,request-upload}.ts`,
      `${M}/shields/**`,
      `${M}/{browser-policy-store,navigation-error-page,session-gate}.ts`,
      `${M}/egress/**`,
      "packages/{policy,egress-policy}/**",
    ],
  },
  {
    tag: "@popup",
    paths: [`${M}/auth-popup-window.ts`, "apps/desktop/src/preload/auth-popup.ts", `${C}/auth-popup.ts`],
  },
  {
    tag: "@media",
    paths: [
      `${UI}/components/{MediaStack,ScreenShareIndicator,media-icons}.tsx`,
      `${UI}/components/useMediaPresence.ts`,
      `${UI}/lib/{media-presence,media-stack}.ts`,
      `${C}/{media,screen-share}.ts`,
    ],
  },
  {
    tag: "@notices",
    paths: [`${UI}/components/{NoticeHost,NoticeStack}.tsx`, `${UI}/NoticeApp.tsx`, `${UI}/lib/notices.ts`, `${C}/notice.ts`, `${M}/notice-layer.ts`],
  },
  {
    tag: "@pages",
    paths: [
      `${UI}/components/{notes,bookmarks,watchtower,reports,reminders,library}/**`,
      `${UI}/{BookmarkToastApp,FindApp}.tsx`,
      `${UI}/components/StreamFindBar.tsx`,
      `${UI}/lib/{notes-autosave,notes-images,notes-markdown,notes-slash,reports,calendar-split,stream-menu,library}.ts`,
      `${C}/{notes,bookmarks,watchtower,reports,reminders,double-shift,reader,reader-extract,tab-archive}.ts`,
      `${M}/{note-store,bookmark-store,bookmarks,bookmark-extractor,brief-service,brief-scheduler,reminder-store,reminder-scheduler,reader-store,reader-extract,smart-find}.ts`,
      `${M}/watchtower/**`,
      "packages/{notes,watchtower,reports,smart-find,notifications}/**",
    ],
  },
  {
    tag: "@screenshot",
    paths: [`${UI}/components/ScreenshotOverlay.tsx`, `${UI}/lib/screenshot.ts`, `${C}/screenshot.ts`, `${M}/{screenshots,window-compose}.ts`],
  },
  {
    tag: "@startup",
    paths: [`${M}/{tab-session-store,session-gate,feature-handlers}.ts`],
  },
  {
    // The web app, the site and the cloud: their specs boot the web stack
    // (e2e/tests/web-harness.ts). Desktop-only changes never run them. Splits
    // and the pane toolbar are the web's alone since 2026-10-09 (the desktop
    // tiles windows on its desk instead).
    tag: "@web",
    paths: [
      "apps/{web,www}/**",
      "services/**",
      "packages/{browser-client,dom-mirror,live-view,web-account,sync-engine,sync-hub,sync-protocol,ui}/**",
      `${UI}/{surface.tsx,lib/surface-copy.ts,lib/live-view.ts,lib/cloud.ts,lib/sync.ts}`,
      `${UI}/components/{LiveViewPage,SyncPill,PaneToolbar,split-icons}.tsx`,
      `${UI}/lib/{split-layout,pane-toolbar,viewport}.ts`,
      `${UI}/chrome/split-mode.ts`,
      `${C}/split.ts`,
      `${M}/{sync,cloud}/**`,
      "apps/desktop/e2e/tests/web-harness.ts",
    ],
  },
];

/**
 * Paths that touch every area. A change here runs the smoke tests (and the
 * areas of anything else that changed), not the whole suite. The desk's mount
 * (ContentArea, DeskSurface), its store and the sidebar's layout are among
 * them since 2026-10-09: every desktop spec stands on the desk.
 */
export const HUB_PATHS = [
  `${M}/{index,browser-controller}.ts`,
  "apps/desktop/src/preload/{index,tab}.ts",
  "apps/desktop/src/renderer/**",
  `${UI}/{App.tsx,ChromeLayoutRoot.tsx,store.ts,api.ts,index.ts,shell.css}`,
  `${UI}/components/{ContentArea,desk/DeskSurface}.tsx`,
  `${UI}/layouts/SidebarLayout.tsx`,
  `${UI}/lib/desk/{store,open}.ts`,
  `${UI}/components/Favicon.tsx`,
  `${UI}/components/ui/**`,
  `${UI}/lib/cn.ts`,
  `${C}/{ipc,socket}.ts`,
  "apps/desktop/{electron.vite.config.ts,package.json}",
];

/** Never runs e2e: docs, unit tests, design files, tooling the app does not ship. */
export const IGNORE_PATHS = [
  "**/*.md",
  "docs/**",
  "design/**",
  "videos/**",
  ".claude/**",
  "**/test/**",
  "apps/desktop/e2e/exploration/**",
  "apps/desktop/e2e/screenshots/**",
  "scripts/{publish-public.sh,dev-ready.mjs}",
];

/** e2e infrastructure every spec stands on: a change runs the whole suite. */
export const WHOLE_SUITE_PATHS = ["apps/desktop/e2e/playwright.config.ts", "scripts/test-tmpdir.mjs", "patches/**", "pnpm-lock.yaml"];
