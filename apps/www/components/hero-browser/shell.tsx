"use client";

/**
 * The hero's browser: the shell tree over the in-memory host (./demo-host.ts).
 *
 * The web app's counterpart is `packages/browser-client/components/shell-tree`.
 * This one differs in what fills a pane — a page from the catalog rather
 * than a screencast — and in nothing else: the same `App`, the same store,
 * the same chrome. Loaded with `ssr: false` by the route, because the shell's
 * modules read `navigator` as they evaluate.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BrowserTabInfo, ShellApi } from "@pistachio/shell-contracts/ipc";
import { App, setShellApi, SurfaceProvider, ThemeRuntime, useAppStore, type Surface } from "@pistachio/shell-ui";
import { youtubeVideo } from "./catalog";
import { createDemoShellApi, type DemoShellHost } from "./demo-host";
import { MockPage, PaneContext, VideoArt, type PaneActions } from "./pages";
import { TourDirector } from "./tour";
import { TOUR_PAINTED } from "./tour-protocol";

function DemoPane({ api, host, tab }: { api: ShellApi; host: DemoShellHost; tab: BrowserTabInfo }): ReactNode {
  const value = useMemo<PaneActions>(
    () => ({
      navigate: (url) => void api.navigate(tab.id, url),
      glance: (url, box) => void host.glance(url, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }),
      readAloud: () => host.readArticleAloud(),
    }),
    [api, host, tab.id],
  );
  return (
    <PaneContext.Provider value={value}>
      {/* A fresh document per address, as a real navigation is. */}
      <div key={tab.url} data-testid="demo-page" data-url={tab.url} className="demo-page h-full w-full overflow-hidden bg-white">
        <MockPage url={tab.url} />
      </div>
    </PaneContext.Provider>
  );
}

/** A background video's picture in its sidebar card: the same footage its tab was showing. */
function MediaPreview({ tabId }: { tabId: string }): ReactNode {
  const url = useAppStore((state) => state.snapshot?.tabs.find((tab) => tab.id === tabId)?.url ?? null);
  const video = url === null ? null : youtubeVideo(url);
  return video === null ? null : <VideoArt video={video} className="size-full" />;
}

/** The three buttons macOS draws in the corner the shell leaves for them. */
function TrafficLights(): ReactNode {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute top-[15px] left-4 z-20 flex gap-2">
      <span className="size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
      <span className="size-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
      <span className="size-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)]" />
    </div>
  );
}

export default function HeroShell({ downloadUrl, accountUrl }: { downloadUrl: string; accountUrl: string }): ReactNode {
  // One host per mount: the store reaches for `shellApi()` the moment `App`
  // mounts, so the bridge is installed during the first render, not in an
  // effect after it.
  const [{ api, host }] = useState(() => createDemoShellApi());
  const installed = useRef<ShellApi | null>(null);
  if (installed.current !== api) {
    setShellApi(api);
    installed.current = api;
  }

  // Links the shell renders (the download button, the account page) leave
  // the frame: a site opening inside its own hero would be a hall of mirrors.
  useEffect(() => {
    if (window.parent === window) return;
    const base = document.createElement("base");
    base.target = "_top";
    document.head.append(base);
    return () => base.remove();
  }, []);

  // Tell the page once the chrome is on screen: it shows a skeleton of the
  // window until then and fades this frame in over it.
  const ready = useAppStore((state) => state.snapshot !== null);
  useEffect(() => {
    if (!ready || window.parent === window) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => window.parent.postMessage({ type: TOUR_PAINTED }, window.location.origin));
    });
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const surface = useMemo<Surface>(
    () => ({
      kind: "stream",
      renderPane: (tab) => <DemoPane key={tab.id} api={api} host={host} tab={tab} />,
      renderGlance: (tab) => (
        <div data-testid="demo-glance" className="demo-page h-full w-full overflow-hidden bg-white">
          <MockPage url={tab.url} />
        </div>
      ),
      renderMediaPreview: (tabId) => <MediaPreview tabId={tabId} />,
      rendering: null,
      downloadUrl,
      accountUrl,
    }),
    [api, host, downloadUrl, accountUrl],
  );

  return (
    <SurfaceProvider value={surface}>
      <ThemeRuntime />
      <TrafficLights />
      <App />
      <TourDirector host={host} />
    </SurfaceProvider>
  );
}
