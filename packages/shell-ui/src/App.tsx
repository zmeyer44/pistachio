import { lazy, Suspense, useEffect, useState } from "react";
import { nativeApi, shellApi } from "./api";
import { ChromeShortcuts } from "./chrome/actions";
import { ShellHostProvider } from "./chrome/shell-host";
import { ChromeLayoutRoot } from "./ChromeLayoutRoot";
import { NoticeHost } from "./components/NoticeHost";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { PistachioMark } from "./components/PistachioMark";
import { useAppStore } from "./store";

const DownloadsList = lazy(() => import("./components/DownloadsPopover").then((m) => ({ default: m.DownloadsPopover })));

/** The downloads list, loaded the first time it is opened (App is on the launch path). */
function DownloadsPopover() {
  return (
    <Suspense fallback={null}>
      <DownloadsList />
    </Suspense>
  );
}


export function App() {
  const initialize = useAppStore((state) => state.initialize);
  // Only whether main has answered yet: the chrome below selects the slices
  // it renders from, so a title tick does not re-render from the root.
  const ready = useAppStore((state) => state.snapshot !== null);
  const error = useAppStore((state) => state.error);
  // Whether the walkthrough is coming, known BEFORE main's first answer: a
  // native window states it synchronously (NativeSurfaceApi.launchState),
  // so the frames before the snapshot can already wear the wizard's ground
  // rather than the chrome. Read once, at the first render — the store
  // itself is created while the entry's imports evaluate, before the entry
  // has set the bridge. A stream surface has no such fact and waits as it
  // did. The settings that arrive with the snapshot remain the authority.
  const [firstRun] = useState(() => nativeApi()?.launchState().firstRun ?? false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void initialize().then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => unsubscribe?.();
  }, [initialize]);

  // The chrome shows whether Watchtower is recording; ask once at startup,
  // the Watchtower page keeps it current after that.
  const setWatchtowerCapture = useAppStore((s) => s.setWatchtowerCapture);
  useEffect(() => {
    if (nativeApi() === null) return;
    void shellApi()
      .watchtower({ type: "status" })
      .then(({ settings, stats }) =>
        setWatchtowerCapture(
          !settings.enabled ? "off" : settings.paused || stats.full ? "paused" : "recording",
        ),
      )
      .catch(() => {});
  }, [setWatchtowerCapture]);

  // The tab WebContentsViews sit ABOVE this page, so any surface drawn over
  // the content hole is invisible until main raises the chrome. Report exactly
  // the states that put something over the hole: a modal or the error toast.
  //
  // Pane-resize and tab-split drags are not overlays. Both go through the
  // transparent drag layer, which takes the pointer without taking the pages
  // down; the native views keep following their live proposed bounds.
  // The first-run wizard covers the whole window, tab views included.
  const shellOverlayActive = useAppStore(
    (state) =>
      state.overlay !== "none" || state.error !== null || state.onboardingOpen,
  );
  const downloadsOpen = useAppStore((state) => state.overlay === "downloads");
  const onboardingOpen = useAppStore((state) => state.onboardingOpen);
  const reportOverlayActive = useAppStore((state) => state.reportOverlayActive);
  useEffect(() => {
    void reportOverlayActive(shellOverlayActive);
  }, [shellOverlayActive, reportOverlayActive]);

  // A pause is the one moment the console must be on screen: surface it when
  // a run enters waiting_for_approval, if the person asked for that.
  const paused = useAppStore((state) => state.snapshot?.run?.status === "waiting_for_approval");
  useEffect(() => {
    const state = useAppStore.getState();
    if (paused && state.settings.approvals.focusConsoleOnPause) state.setConsoleOpen(true);
  }, [paused]);

  return (
    <ShellHostProvider>
      {/* ⌘-shortcuts are the action registry's (chrome/actions.tsx). None
          while the wizard is up: there is no chrome to act on yet. */}
      {onboardingOpen ? null : <ChromeShortcuts />}
      {!ready ? (
        firstRun ? (
          // The wizard needs the loaded account to decide its step list, so
          // until the snapshot lands the window wears the wizard's own ground
          // and nothing else. The wizard then mounts over the chrome in the
          // same commit that mounts the chrome, opaque from its first frame.
          <main
            aria-busy="true"
            data-testid="onboarding-curtain"
            className="theme-window h-full w-full bg-background-100"
          />
        ) : (
          <main className="theme-window grid h-full w-full place-content-center justify-items-center gap-4 bg-background-100 text-label-14 text-gray-900">
            <PistachioMark size={48} />
            <span>Opening secure Space…</span>
          </main>
        )
      ) : (
        <main className="theme-window h-full w-full bg-background-200">
          <ChromeLayoutRoot />
          {/* Mounted over the live chrome, not instead of it: the theme step's
              changes show through as the wizard fades, and the layout under it
              is already reported and laid out when the browser is revealed. */}
          {onboardingOpen ? <OnboardingWizard /> : null}
          {error === null ? null : (
            <div
              role="alert"
              className="fixed right-4 bottom-10 z-100 max-w-105 rounded-md bg-red-100 px-3.5 py-2.5 text-copy-13 text-red-1000 shadow-[0_0_0_1px_var(--color-red-400),0_8px_24px_oklch(0_0_0/0.08)]"
            >
              {error}
            </div>
          )}
          {downloadsOpen ? <DownloadsPopover /> : null}
          {/* The notice stack is no part of the chrome (components/NoticeHost.tsx):
              it shows whatever layout is up and whatever the sidebar is doing. */}
          <NoticeHost />
        </main>
      )}
    </ShellHostProvider>
  );
}
