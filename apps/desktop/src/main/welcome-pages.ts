/**
 * The pages a fresh install opens when the wizard is done — Pistachio's
 * own "welcome" tabs, served at `pistachio://welcome` and
 * `pistachio://learn/<lesson>` (@pistachio/shell-contracts/onboarding WELCOME_TABS) the way
 * the demo portal is (demo-page.ts): real documents in real tabs, so they
 * sit in the sidebar, can be pinned, closed, and reopened from the
 * address bar.
 *
 * They are personal: the greeting carries the name the wizard learned,
 * the shortcut hints are the person's own bindings, and the material is
 * their theme — main hands those in through `setWelcomeContext`, read
 * per request so a change in Settings shows on the next load.
 *
 * THE PAGES THEMSELVES are `@pistachio/shell-contracts/welcome-pages`: pure
 * builders both hosts draw from, because the cloud-browser worker opens the
 * same four documents in a browser tab that has no `pistachio://` protocol to
 * serve them from (docs/web-browser-design.md §14). What is left here is what
 * only a desktop can do: the protocol routing, the files on disk, and the
 * context main reads per request.
 *
 * VIDEOS. Each page keeps a slot for a walkthrough video. WELCOME_VIDEOS
 * (in the package) names each one's source; null draws the "coming soon"
 * card. Sources are the landing page's clips on www.pistachio.run (the page
 * CSP admits https: media and images); local files also work, served from the
 * welcome assets directory (`setWelcomeContext`'s `assetsDir`) at
 * `pistachio://welcome/assets/<file>`.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname, join } from "node:path";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "@pistachio/shell-contracts/appearance";
import { WELCOME_TABS } from "@pistachio/shell-contracts/onboarding";
import { DEFAULT_SHORTCUTS, type ShortcutPlatform, type ShortcutSettings } from "@pistachio/shell-contracts/shortcuts";
import {
  welcomeLessonHtml,
  welcomeOverviewHtml,
  type WelcomePageContext,
} from "@pistachio/shell-contracts/welcome-pages";

export interface WelcomeContext {
  /** The person's name from memory, or "" for a neutral greeting. */
  name: string;
  appearance: AppearanceSettings;
  shortcuts: ShortcutSettings;
  platform: ShortcutPlatform;
  /** Where `/assets/<file>` is served from, or null for none. */
  assetsDir: string | null;
  /** Whether the OS is in dark mode right now, for `scheme: "system"`. */
  systemDark: boolean;
}

let readContext: () => WelcomeContext = () => ({
  name: "",
  appearance: DEFAULT_APPEARANCE,
  shortcuts: DEFAULT_SHORTCUTS,
  platform: "darwin",
  assetsDir: null,
  systemDark: false,
});

export function setWelcomeContext(read: () => WelcomeContext): void {
  readContext = read;
}

/**
 * The desktop's parameters for the shared builders: the links, the assets and
 * the font are all this window's own protocol, which is what the package's
 * defaults already are.
 */
function pageContext(context: WelcomeContext): WelcomePageContext {
  return {
    name: context.name,
    appearance: context.appearance,
    shortcuts: context.shortcuts,
    platform: context.platform,
    systemDark: context.systemDark,
  };
}

/* -------------------------------- routing ------------------------------- */

const ASSET_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** Serve a welcome address, or null when the address is not one of ours. */
export function welcomePageResponse(url: URL): Response | null {
  if (url.host === "welcome") {
    if (url.pathname === "/" || url.pathname === "") return html(welcomeOverviewHtml(pageContext(readContext())));
    if (url.pathname.startsWith("/assets/")) return assetResponse(url.pathname.slice("/assets/".length), readContext());
    return new Response("Not found", { status: 404 });
  }
  if (url.host === "learn") {
    const lesson = WELCOME_TABS.find((tab) => tab.id !== "overview" && new URL(tab.url).pathname === url.pathname);
    if (lesson === undefined) return new Response("Not found", { status: 404 });
    return html(welcomeLessonHtml(lesson, pageContext(readContext())));
  }
  return null;
}

function assetResponse(name: string, context: WelcomeContext): Response {
  const file = basename(name);
  const type = ASSET_TYPES[extname(file).toLowerCase()];
  if (type === undefined || file !== name) return new Response("Not found", { status: 404 });
  if (file === "geist.woff2") {
    const font = geistFont();
    return font === null
      ? new Response("Not found", { status: 404 })
      : new Response(new Blob([plainBytes(font)], { type }), {
          status: 200,
          headers: { "content-type": type, "cache-control": "public, max-age=86400" },
        });
  }
  if (context.assetsDir === null) return new Response("Not found", { status: 404 });
  const path = join(context.assetsDir, file);
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  try {
    return new Response(new Blob([plainBytes(readFileSync(path))], { type }), { status: 200, headers: { "content-type": type } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/** A copy in a plain ArrayBuffer, so the Blob never aliases a shared or pooled buffer. */
function plainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/** The renderer's own face, so the pages read as part of the window. */
function geistFont(): Uint8Array | null {
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2");
    return new Uint8Array(readFileSync(path));
  } catch {
    return null;
  }
}
