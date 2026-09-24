"use client";

import { useLinked } from "./linked-controls";

/**
 * Which way one pane is painted (docs/web-browser-design.md §16).
 *
 * A pane is either a screencast (`StreamedPane`, pixels the cloud took) or a
 * live DOM mirror (`MirrorPane`, the document rebuilt here). The choice starts
 * from the person's preference and flips to pixels on its own for a tab whose
 * page cannot be mirrored — a WebGL canvas, a playing video — so the fallback
 * §16 requires is automatic and per tab, not a setting the person has to find.
 *
 * The renderPane seam hands this a tab; everything else about the pane, and
 * both ways of painting it, live below here.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";
import type { SurfaceRendering } from "@pistachio/shell-ui";
import { StreamedPane } from "./streamed-pane";
import { EditorInput } from "./editor-input";
import { MirrorPane } from "./mirror-pane";
import { preferredRenderer } from "../lib/renderer-preference";
import type { WsShellApi } from "../lib/shell-socket";
import type { UnsuitableReason, AssetFailure } from "@pistachio/dom-mirror";

const FALLBACK_REASON: Record<UnsuitableReason | "timeout", string> = {
  video: "This page’s media could not be relayed for local playback.",
  frame: "This page has an embedded frame.",
  editor: "A rich text editor is active. Pixels preserve editing behavior.",
  webgl: "This page uses GPU graphics.",
  plugin: "This page has embedded plugin content.",
  password: "This page has a prefilled password field.",
  asset: "A required stylesheet could not be mirrored.",
  too_large: "The page exceeded the mirror's size or update limit.",
  error: "The DOM mirror could not start or update.",
  timeout: "The DOM mirror did not respond in time.",
};

// Only our own diagnostic codes become UI copy. Page-provided exception text
// must not escape into the shell, logs, or a person's rendering status.
const ASSET_REASON: Record<AssetFailure["reason"], string> = {
  pending: "The resource is still loading.",
  "source-http": "The website returned an error for this resource.",
  "source-network": "The cloud browser could not load this resource.",
  capture: "The response bytes could not be captured from the cloud browser.",
  "too-large": "The resource exceeds the mirror’s size limit.",
  evicted: "The resource was removed from the mirror cache.",
  unknown: "The resource is no longer available in the mirror cache.",
  transport: "The resource could not be transferred to your browser.",
  timeout: "The resource did not arrive after retries.",
  queue: "The resource transfer queue is full.",
};
const FALLBACK_DETAIL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ASSET_REASON).map(([code, text]) => [`asset-${code}`, `A required stylesheet could not be mirrored. ${text}`])),
  "startup-instrument": "The cloud page could not initialize DOM mirroring.",
  "startup-record": "The cloud page could not produce a DOM snapshot.",
  "startup-validate": "The cloud page returned an invalid DOM snapshot.",
  "startup-rewrite": "The cloud DOM snapshot could not be prepared for display.",
  "startup-send": "The cloud DOM snapshot could not be sent.",
  "surface-snapshot": "Your browser could not render the DOM snapshot.",
  "surface-patch": "Your browser could not apply a DOM update.",
  "surface-asset": "Your browser could not apply a mirrored page asset.",
  "timeout-surface": "The local DOM renderer did not initialize in time.",
  "timeout-snapshot": "No DOM snapshot arrived from the cloud browser in time.",
  "timeout-paint": "A DOM snapshot arrived, but your browser did not finish rendering it.",
};

export function Pane({ active, api, tab, onRenderingChange }: {
  active: boolean;
  api: WsShellApi;
  tab: BrowserTabInfo;
  onRenderingChange: Dispatch<SetStateAction<SurfaceRendering | null>>;
}): ReactNode {
  const linked = useLinked(api);
  // Per tab, remembered while the pane lives; a fresh tab reads the preference.
  const [mode, setMode] = useState<SurfaceRendering["mode"]>(() => preferredRenderer());
  const [mediaCount, setMediaCount] = useState(0);
  const [reason, setReason] = useState<string>();
  const [assetWarning, setAssetWarning] = useState<string>();
  const assetStatus = useCallback(({ count, failure }: { count: number; failure?: AssetFailure }) => {
    const kind = failure?.context === "style" ? "stylesheet" : failure?.context ?? "resource";
    setAssetWarning(count && failure ? `${count} page resource${count === 1 ? " is" : "s are"} unavailable (${kind}${failure.status ? `, HTTP ${failure.status}` : ""}). ${ASSET_REASON[failure.reason]}` : undefined);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<{ epoch: number; id: number; point?: { fx: number; fy: number; modifiers: number } } | null>(null);
  const pendingEditor = useRef(false);
  const beginEditor = useCallback((request: { epoch: number; id: number; point?: { fx: number; fy: number; modifiers: number } }) => {
    if (pendingEditor.current) return;
    pendingEditor.current = true; setEditor(request);
  }, []);
  const editorReady = useCallback(() => { setReason(FALLBACK_REASON.editor); setMediaCount(0); setMode("fallback"); }, []);
  const retryDom = useCallback(() => { pendingEditor.current = false; setEditor(null); setReason(undefined); setMediaCount(0); setMode("dom"); }, []);

  const usePixels = useCallback(() => { pendingEditor.current = false; setEditor(null); setReason(undefined); setMediaCount(0); setMode("pixels"); }, []);

  // Only the focused pane reports status, including in split view. Clear only
  // our own report so an outgoing pane cannot erase the next pane's status.
  useEffect(() => {
    if (!active) return;
    const rendering: SurfaceRendering = { tabId: tab.id, mode, mediaCount, ...((mode === "dom" ? assetWarning : reason) ? { reason: mode === "dom" ? assetWarning : reason } : {}), ...(mode === "dom" ? { usePixels } : { retryDom }) };
    onRenderingChange(rendering);
    return () => onRenderingChange(current => current === rendering ? null : current);
  }, [active, tab.id, mode, mediaCount, reason, assetWarning, retryDom, usePixels, onRenderingChange]);

  const fallback = useCallback((reason: UnsuitableReason | "timeout", detail?: string) => {
    if (pendingEditor.current && reason === "editor") return;
    const diagnostic = detail && Object.hasOwn(FALLBACK_DETAIL, detail) ? detail : undefined;
    console.debug(`[mirror] Falling back to pixels: ${reason}${diagnostic ? ` (${diagnostic})` : ""}`);
    setReason((diagnostic ? FALLBACK_DETAIL[diagnostic] : undefined) ?? FALLBACK_REASON[reason]);
    setMediaCount(0); setMode("fallback");
  }, []);

  return <>
    {mode === "dom" && !linked.enabled ? <MirrorPane active={active} api={api} tab={tab} onFallback={fallback} onMediaChange={setMediaCount} onEditor={beginEditor} onAssetStatus={assetStatus} />
      : <StreamedPane active={active} api={api} tab={tab} onMediaChange={setMediaCount} editorInput={editor ? inputRef : undefined} />}
    {editor && !linked.enabled ? <EditorInput api={api} tabId={tab.id} request={editor} inputRef={inputRef} onReady={editorReady} /> : null}
  </>;
}
