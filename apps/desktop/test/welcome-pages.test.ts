/**
 * The welcome pages moved to `@pistachio/shell-contracts/welcome-pages` so
 * the cloud-browser host can render the same four documents into `data:` tabs
 * (docs/web-browser-design.md §14). The desktop kept only the protocol
 * routing and the files on disk — and its OUTPUT has to be what it was.
 *
 * The fixtures beside this file were captured from the pre-lift
 * `apps/desktop/src/main/welcome-pages.ts` before a line of it changed. A
 * byte that moves here is a change to what a person sees, not a refactor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "@pistachio/shell-contracts/appearance";
import { DEFAULT_SHORTCUTS } from "@pistachio/shell-contracts/shortcuts";
import { welcomeTabFor, WELCOME_VIDEOS } from "@pistachio/shell-contracts/welcome-pages";
import { setWelcomeContext, welcomePageResponse } from "../src/main/welcome-pages";

const CASES = [
  { name: "overview-system", url: "pistachio://welcome/", scheme: "system", systemDark: false, platform: "darwin" },
  { name: "overview-dark", url: "pistachio://welcome/", scheme: "dark", systemDark: true, platform: "other" },
  { name: "learn-agent", url: "pistachio://learn/agent", scheme: "system", systemDark: false, platform: "darwin" },
  { name: "learn-spaces", url: "pistachio://learn/spaces", scheme: "light", systemDark: false, platform: "other" },
  { name: "learn-memory", url: "pistachio://learn/memory", scheme: "system", systemDark: true, platform: "darwin" },
] as const;

function golden(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", "welcome-pages", `${name}.html`), "utf8");
}

async function render(entry: (typeof CASES)[number]): Promise<string> {
  setWelcomeContext(() => ({
    // The dark case is the one with no name: a neutral greeting is a case too.
    name: entry.name === "overview-dark" ? "" : "Claudius Meyer",
    appearance: { ...DEFAULT_APPEARANCE, scheme: entry.scheme, radius: 12, texture: 0.2 },
    shortcuts: DEFAULT_SHORTCUTS,
    platform: entry.platform,
    assetsDir: null,
    systemDark: entry.systemDark,
  }));
  const response = welcomePageResponse(new URL(entry.url));
  expect(response).not.toBeNull();
  return response!.text();
}

describe("welcome pages", () => {
  for (const entry of CASES) {
    it(`renders ${entry.name} exactly as the desktop did before the lift`, async () => {
      expect(await render(entry)).toBe(golden(entry.name));
    });
  }

  it("still serves the font and refuses anything outside the assets directory", async () => {
    setWelcomeContext(() => ({
      name: "",
      appearance: DEFAULT_APPEARANCE,
      shortcuts: DEFAULT_SHORTCUTS,
      platform: "darwin",
      assetsDir: null,
      systemDark: false,
    }));
    const font = welcomePageResponse(new URL("pistachio://welcome/assets/geist.woff2"));
    expect(font?.status).toBe(200);
    expect(font?.headers.get("content-type")).toBe("font/woff2");
    expect(welcomePageResponse(new URL("pistachio://welcome/assets/../secrets.png"))?.status).toBe(404);
    expect(welcomePageResponse(new URL("pistachio://welcome/assets/tour.mp4"))?.status).toBe(404);
    expect(welcomePageResponse(new URL("pistachio://learn/nothing"))?.status).toBe(404);
    expect(welcomePageResponse(new URL("pistachio://demo/"))).toBeNull();
  });

  it("resolves a welcome address to the tab it names", () => {
    expect(welcomeTabFor("pistachio://welcome/")?.id).toBe("overview");
    expect(welcomeTabFor("pistachio://welcome")?.id).toBe("overview");
    expect(welcomeTabFor("pistachio://learn/spaces")?.id).toBe("spaces");
    expect(welcomeTabFor("https://example.com/")).toBeNull();
    expect(WELCOME_VIDEOS.memory.src).toBeNull();
  });
});
