import {
  BaseWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from "electron";
import type { PendingPasskeyRequest } from "@pistachio/shell-contracts/browser-controls";
import { fileURLToPath } from "node:url";

export const AUTH_POPUP_BAR_HEIGHT = 36;

/** The pseudo-navigation the bar issues when its button is pressed. */
export const OPEN_IN_MAIN_APP_ACTION = "pistachio-popup:open-in-main-app";
const SELECT_PASSKEY_CHANNEL = "pistachio:popup-select-passkey";

export interface AuthenticationPopupBarOptions {
  dark: boolean;
  /** Called with the page URL the popup currently shows. */
  onOpenInMainApp: (url: string) => void;
  onSelectPasskey: (requestId: string, accountId: string | null) => void;
}

/** Inline markup for the strip above the popup page: no preload, no remote content. */
export function authenticationPopupBarHtml(dark: boolean): string {
  const background = dark ? "#202225" : "#f8f8f3";
  const foreground = dark ? "#e6e6e1" : "#1f1f1c";
  const muted = dark ? "#9a9a95" : "#6c6c67";
  const border = dark ? "#33363a" : "#dcdcd5";
  const buttonBackground = dark ? "#2f3236" : "#ffffff";
  const buttonHover = dark ? "#3a3d42" : "#efefe9";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in window</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body {
    box-sizing: border-box;
    background: ${background}; color: ${foreground};
    border-bottom: 1px solid ${border};
    font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  header { height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 8px 0 12px; box-sizing: border-box; }
  [hidden] { display: none !important; }
  main { padding: 24px; overflow: auto; max-height: calc(100% - 36px); box-sizing: border-box; }
  h1 { font-size: 19px; line-height: 1.35; overflow-wrap: anywhere; margin: 0 0 8px; }
  p { color: ${muted}; line-height: 1.5; overflow-wrap: anywhere; }
  #accounts { display: grid; gap: 8px; margin: 20px 0 16px; }
  #accounts button { text-align: left; padding: 12px; }
  #accounts strong, #accounts span { display: block; overflow-wrap: anywhere; }
  #accounts span { margin-top: 4px; color: ${muted}; font-weight: 400; }
  #host { color: ${muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    flex: none; appearance: none; cursor: default;
    padding: 4px 10px; border-radius: 6px; border: 1px solid ${border};
    background: ${buttonBackground}; color: ${foreground}; font: inherit; font-weight: 500;
  }
  button:hover { background: ${buttonHover}; }
  button:focus-visible { outline: 2px solid #4c8bf5; outline-offset: 1px; }
</style></head>
<body>
  <header>
  <span id="host" aria-live="polite">Sign-in window</span>
  <button type="button" id="open" title="Continue this page in a regular tab">Open in Main App</button>
  </header>
  <main hidden data-testid="passkey-account-chooser" role="dialog" aria-modal="true" aria-labelledby="passkey-title">
    <h1 id="passkey-title"></h1>
    <p id="passkey-origin"></p><p>Select the account you want to sign in with.</p>
    <div id="accounts"></div><button id="cancel" type="button">Cancel</button>
  </main>
  <script>
    document.getElementById("open").addEventListener("click", () => {
      window.location.href = ${JSON.stringify(OPEN_IN_MAIN_APP_ACTION)};
    });
    window.setHost = (host) => {
      document.getElementById("host").textContent = host || "Sign-in window";
    };
    let request = null;
    const select = (accountId) => {
      if (!request) return;
      window.pistachioPopup.selectPasskey(request.id, accountId);
    };
    document.getElementById('cancel').onclick = () => select(null);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && request) { event.preventDefault(); select(null); }
    });
    window.setPasskeyRequest = (value) => {
      request = value;
      document.querySelector('main').hidden = value === null;
      document.getElementById('open').hidden = value !== null;
      const accounts = document.getElementById('accounts');
      accounts.replaceChildren();
      if (!value) return;
      document.getElementById('passkey-title').textContent = 'Choose a passkey for ' + value.relyingPartyId;
      document.getElementById('passkey-origin').textContent = value.origin;
      for (const account of value.accounts) {
        const button = document.createElement('button');
        const name = document.createElement('strong');
        const email = document.createElement('span');
        name.textContent = account.displayName;
        email.textContent = account.name;
        button.append(name, email);
        button.onclick = () => select(account.id);
        accounts.append(button);
      }
      accounts.querySelector('button')?.focus();
    };
  </script>
</body></html>`;
}

export interface AuthenticationPopupWindow {
  window: BaseWindow;
  /** The child browsing context the page's `window.open()` call receives. */
  page: WebContents;
  showPasskeyRequest: (request: PendingPasskeyRequest | null) => void;
}

/**
 * Build the window handed back from a `setWindowOpenHandler` `createWindow`
 * callback: a thin app-owned strip above the popup page so the user can bail
 * out of the popup into a regular tab, with the page laid out beneath it
 * rather than covered by it. A plain BrowserWindow paints its page natively
 * across the whole window, which is why the page is a child view here too.
 */
export function createAuthenticationPopupWindow(
  windowOptions: BrowserWindowConstructorOptions,
  options: AuthenticationPopupBarOptions,
): AuthenticationPopupWindow {
  // Electron hands the Chromium-created guest contents (the one holding the
  // opener relationship) along in `webContents`; the typings omit it.
  const { webPreferences, webContents, ...baseOptions } =
    windowOptions as BrowserWindowConstructorOptions & {
      webContents?: WebContents;
    };
  const window = new BaseWindow({
    ...baseOptions,
    height: (baseOptions.height ?? 600) + AUTH_POPUP_BAR_HEIGHT,
    minHeight: (baseOptions.minHeight ?? 0) + AUTH_POPUP_BAR_HEIGHT,
  });
  const pageView = new WebContentsView(
    webContents === undefined
      ? { webPreferences: webPreferences ?? {} }
      : { webContents, webPreferences: webPreferences ?? {} },
  );
  const page = pageView.webContents;
  let passkeyRequest: PendingPasskeyRequest | null = null;
  const bar = new WebContentsView({
    webPreferences: {
      preload: fileURLToPath(
        new URL("../preload/auth-popup.cjs", import.meta.url),
      ),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (baseOptions.backgroundColor !== undefined)
    pageView.setBackgroundColor(baseOptions.backgroundColor);
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Listen on this trusted WebContents only: the site and other popup strips
  // cannot answer this request, even if they learn its opaque option IDs.
  bar.webContents.on(
    "ipc-message",
    (_event, channel, requestId: unknown, accountId: unknown) => {
      if (channel === SELECT_PASSKEY_CHANNEL) {
        if (
          passkeyRequest !== null &&
          requestId === passkeyRequest.id &&
          (accountId === null ||
            (typeof accountId === "string" &&
              passkeyRequest.accounts.some(
                (account) => account.id === accountId,
              )))
        ) {
          options.onSelectPasskey(requestId, accountId);
        }
      }
    },
  );
  bar.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url !== OPEN_IN_MAIN_APP_ACTION) return;
    if (page.isDestroyed()) return;
    options.onOpenInMainApp(page.getURL());
  });
  window.contentView.addChildView(pageView);
  window.contentView.addChildView(bar);

  const layout = (): void => {
    if (window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    bar.setBounds({
      x: 0,
      y: 0,
      width,
      height: passkeyRequest === null ? AUTH_POPUP_BAR_HEIGHT : height,
    });
    pageView.setVisible(passkeyRequest === null);
    pageView.setBounds({
      x: 0,
      y: AUTH_POPUP_BAR_HEIGHT,
      width,
      height: Math.max(0, height - AUTH_POPUP_BAR_HEIGHT),
    });
  };
  const renderPasskeyRequest = (): void => {
    if (bar.webContents.isDestroyed()) return;
    void bar.webContents
      .executeJavaScript(
        `window.setPasskeyRequest(${JSON.stringify(passkeyRequest)})`,
      )
      .catch(() => undefined);
  };
  bar.webContents.on("did-finish-load", renderPasskeyRequest);
  window.on("resize", layout);
  window.on("enter-full-screen", layout);
  window.on("leave-full-screen", layout);
  layout();
  // Chromium hands over the child contents before it has a widget to size, so
  // bounds applied synchronously leave a 0x0 viewport; apply them again once
  // the contents are live and again whenever a document arrives.
  setImmediate(layout);
  page.on("did-start-loading", layout);
  page.on("dom-ready", layout);

  const showHost = (): void => {
    if (page.isDestroyed() || bar.webContents.isDestroyed()) return;
    let host = "";
    try {
      host = new URL(page.getURL()).host;
    } catch {
      host = "";
    }
    void bar.webContents
      .executeJavaScript(`window.setHost(${JSON.stringify(host)})`)
      .catch(() => undefined);
  };
  page.on("did-navigate", showHost);
  page.on("did-navigate-in-page", showHost);
  page.on("page-title-updated", (_event, title) => {
    if (!window.isDestroyed()) window.setTitle(title);
  });
  // The page's own window.close() (how OAuth callbacks finish) must take the
  // window with it, and closing the window must tear the page down.
  page.once("destroyed", () => {
    if (!window.isDestroyed()) window.close();
  });
  window.once("closed", () => {
    if (!page.isDestroyed()) page.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
  });

  void bar.webContents
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(authenticationPopupBarHtml(options.dark))}`,
    )
    .then(showHost)
    .catch(() => undefined);

  return {
    window,
    page,
    showPasskeyRequest: (request) => {
      passkeyRequest = request;
      layout();
      renderPasskeyRequest();
      if (request !== null && !bar.webContents.isDestroyed())
        bar.webContents.focus();
      else if (!page.isDestroyed()) page.focus();
    },
  };
}
