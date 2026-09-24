import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { chromeViewFromHash, type ChromeViewId } from "@pistachio/shell-contracts/chrome";
import { setShellApi, SurfaceProvider, ThemeRuntime } from "@pistachio/shell-ui";
import "./styles.css";

// The desktop's entry (docs/web-browser-design.md §3.2): it names the bridge
// and the surface, and the shell itself lives in @pistachio/shell-ui, where
// the web app mounts the same tree over streamed panes.
setShellApi(window.pistachio);

// The same bundle serves the shell window and the utility chrome views above
// its native tab views: drag capture, find-in-page, the bookmark card and
// the notice stack (main/chrome-view.ts).
// Each loads this page with the hash that names it (@pistachio/shell-contracts/chrome).
// Each view is its own lazy chunk, so a utility page never evaluates the
// shell's code (the store, the console, settings, onboarding) and the shell
// never evaluates theirs. React itself is the shared vendor chunk
// (electron.vite.config.ts).
const App = React.lazy(() =>
  import("@pistachio/shell-ui/App.js").then((module) => ({ default: module.App })),
);
const BookmarkToastApp = React.lazy(() =>
  import("@pistachio/shell-ui/BookmarkToastApp.js").then((module) => ({
    default: module.BookmarkToastApp,
  })),
);
const NoticeApp = React.lazy(() =>
  import("@pistachio/shell-ui/NoticeApp.js").then((module) => ({ default: module.NoticeApp })),
);
const DragApp = React.lazy(() =>
  import("@pistachio/shell-ui/DragApp.js").then((module) => ({ default: module.DragApp })),
);
const FindApp = React.lazy(() =>
  import("@pistachio/shell-ui/FindApp.js").then((module) => ({ default: module.FindApp })),
);

const view = chromeViewFromHash(window.location.hash);
if (view !== null) document.body.dataset["chromeView"] = view;

function Root({ view }: { view: ChromeViewId | null }) {
  switch (view) {
    case "drag":
      return <DragApp />;
    case "find":
      return <FindApp />;
    case "bookmark":
      return <BookmarkToastApp />;
    case "notice":
      return <NoticeApp />;
    case null:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SurfaceProvider value={{ kind: "native" }}>
      <ThemeRuntime />
      <Suspense fallback={null}>
        <Root view={view} />
      </Suspense>
    </SurfaceProvider>
  </React.StrictMode>,
);
