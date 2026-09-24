/**
 * The shell (docs/web-browser-design.md §3.2). One React tree, two surfaces:
 * the desktop renderer mounts it over native tab views, the web app mounts it
 * over streamed panes. An entry sets the bridge (`setShellApi`), names the
 * surface (`SurfaceProvider`), and renders `App`.
 */

export { App } from "./App";
export { BookmarkToastApp } from "./BookmarkToastApp";
export { NoticeApp } from "./NoticeApp";
export { DragApp } from "./DragApp";
export { FindApp } from "./FindApp";
export { ThemeRuntime } from "./theme/ThemeRuntime";

export { nativeApi, setShellApi, shellApi, type ShellApiBridge } from "./api";
export { SurfaceProvider, useSurface, type Surface, type SurfaceRendering } from "./surface";
/** The placeholder a stream pane shows until its first paint, the same one a waking tab shows. */
export { PanePlaceholder } from "./components/PanePlaceholder";

export {
  useAppStore,
  /** The store's name in the shared contract; `useAppStore` is the same hook. */
  useAppStore as useStore,
  type AppState,
  type Attempt,
  type ChatInbox,
  type Overlay,
  type NoticeOptions,
  type ShellNotice,
  type SplitDragTab,
} from "./store";

/**
 * The stream surface's own pure helpers (§10): what the page context menu is
 * told, and what a DOM menu has to supply where Chromium supplied it. The web
 * app wires them to `StreamShellApi` calls and forwarded input.
 */
export {
  acceleratorLabel,
  isStreamReaderUrl,
  streamEditRow,
  streamMediaFlags,
  streamMenuState,
  viewerPlatform,
  type StreamEditChord,
  type StreamEditRow,
  type StreamEditVerb,
} from "./lib/stream-menu";
