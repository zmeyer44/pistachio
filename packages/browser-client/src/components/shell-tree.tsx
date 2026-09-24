"use client";

/**
 * The shell itself (docs/web-browser-design.md §3.2, §7).
 *
 * This is the web's counterpart of `apps/desktop/src/renderer/src/main.tsx`:
 * an entry that names the bridge and the surface and then renders the shared
 * tree. Everything specific to a browser tab is on this side of the seam — the
 * socket, the streamed panes — and everything the desktop shows is in
 * `@pistachio/shell-ui`, unchanged.
 *
 * It is a module of its own, loaded with `ssr: false`, because the shell is a
 * browser program: modules under it read `navigator` and `window` as they
 * evaluate, which is fine in the one place they run and fatal on a server.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { App, setShellApi, SurfaceProvider, ThemeRuntime, useAppStore, type Surface, type SurfaceRendering } from "@pistachio/shell-ui";
import { LinkedControls, useLinked } from "./linked-controls";
import { Pane } from "./pane";
import { StreamAnnouncer, useStreamClipboard, useStreamUploads } from "./stream-capabilities";

import type { WsShellApi } from "../lib/shell-socket";

/**
 * The two addresses the shell has to point at and cannot know (§15).
 *
 * `downloadUrl` is the Mac app, for the walkthrough's import step, which can
 * only run there (§14, W12). `accountUrl` is the dashboard's ROOT, for every
 * affordance this host answers with "managed from the web app": the sentence
 * is the host's, and the way there is this app's.
 */
export default function ShellTree({ api, downloadUrl = "https://www.pistachio.run/download", accountUrl = "https://www.pistachio.run/app" }: { api: WsShellApi; downloadUrl?: string; accountUrl?: string }): ReactNode {
  const linked = useLinked(api);
  const following = linked.enabled && linked.controller !== api.viewerId;
  const [rendering, setRendering] = useState<SurfaceRendering | null>(null);
  // Before the first render, and once per bridge: the store reaches for
  // `shellApi()` the moment `App` mounts, and a shell with no bridge is a bug
  // in the entry rather than a state to render around. The page gives this
  // subtree a key of its own per session, so a new socket remounts the tree
  // and the store initializes against it.
  const installed = useRef<WsShellApi | null>(null);
  if (installed.current !== api) {
    setShellApi(api);
    installed.current = api;
  }

  // The page copies the account's database onboarding status to the host
  // before mounting this tree; the store reads it on its first load.

  // A reconnect missed every event in between, and the snapshot is only part
  // of what the store holds: the devices, sync, egress, cloud and channel
  // status, the account, and which members this host refuses were all
  // one-time answers to the first load. The socket says when it came back;
  // the store re-reads the lot (§7).
  useEffect(() => api.onReconnect(() => void useAppStore.getState().resync()), [api]);

  // The two capabilities that belong to the SESSION rather than to a pane:
  // the file picker a page opens (there is only ever one on screen), and the
  // clipboard the person and the page share (§11).
  const filePicker = useStreamUploads(api);
  useStreamClipboard(api);

  const surface = useMemo<Surface>(
    () => ({
      kind: "stream",
      // Compatibility belongs to a page, so navigation gets a fresh DOM attempt.
      renderPane: (tab, pane) => <Pane key={`${tab.id}:${tab.url}`} api={api} tab={tab} active={pane.active} onRenderingChange={setRendering} />,
      rendering,
      downloadUrl,
      accountUrl,
    }),
    [api, rendering, downloadUrl, accountUrl],
  );

  return (
    <SurfaceProvider value={surface}>
      <ThemeRuntime />
      <div inert={following} style={{ display: "contents" }}><App /></div>
      <LinkedControls api={api} />
      <StreamAnnouncer />
      {filePicker}
    </SurfaceProvider>
  );
}
