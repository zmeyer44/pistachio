/**
 * Stand-in local web apps for the address bar's local-apps specs
 * (docs/local-apps.md). Each is its own node process (e2e/fixtures/local-apps/server.mjs)
 * working in its own project folder — a temp repository named for the
 * project — so main reads its title, icon, project and server as it would a
 * real dev server's. Launch the app with `env` (PISTACHIO_LOCAL_APP_PORTS):
 * under e2e main looks at those ports alone, never the machine's own servers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalAppFixture {
  /** The page's <title>; "" for a page with none. */
  title: string;
  /** The folder (a repository) it runs in, which main names the project. */
  project: string;
  /** A word for main to read a server off the command line: "vite", "next", "storybook", "astro", "uvicorn", or "" for plain Node. */
  server: string;
  /** Its icon's colour; "" for an app with no icon. */
  colour: string;
}

/** A plausible morning's dev servers, newest first once started in this order (last started is newest). */
export const LOCAL_APP_FIXTURES: LocalAppFixture[] = [
  { title: "", project: "scratch", server: "", colour: "" },
  { title: "Swagger UI", project: "billing-api", server: "uvicorn", colour: "#49cc90" },
  { title: "Acme — Marketing", project: "acme-marketing", server: "astro", colour: "#ff5d01" },
  { title: "Storybook", project: "design-system", server: "storybook", colour: "#ff4785" },
  { title: "Vite + React + TS", project: "playground", server: "vite", colour: "#646cff" },
  { title: "Acme Dashboard", project: "acme-web", server: "next", colour: "#111111" },
];

export interface LocalApps {
  ports: number[];
  /** For launchApp's `env`. */
  env: { PISTACHIO_LOCAL_APP_PORTS: string };
  stop(): void;
}

export async function startLocalApps(fixtures: LocalAppFixture[] = LOCAL_APP_FIXTURES): Promise<LocalApps> {
  const root = mkdtempSync(join(tmpdir(), "pistachio-local-apps-"));
  const script = fileURLToPath(new URL("../fixtures/local-apps/server.mjs", import.meta.url));
  const children: ChildProcess[] = [];
  const ports: number[] = [];
  for (const fixture of fixtures) {
    const folder = join(root, fixture.project);
    mkdirSync(join(folder, ".git"), { recursive: true });
    const args = [script, fixture.title, fixture.colour, ...(fixture.server === "" ? [] : [fixture.server])];
    const child = spawn(process.execPath, args, { cwd: folder, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    ports.push(
      await new Promise<number>((resolve, reject) => {
        child.stdout?.once("data", (data: Buffer) => resolve(Number(String(data).trim())));
        child.once("exit", () => reject(new Error(`local app ${fixture.project} exited`)));
      }),
    );
    // Distinct start times, so "newest first" has an order to keep (ps reads whole seconds).
    if (fixture !== fixtures.at(-1)) await new Promise((resolve) => setTimeout(resolve, 1_050));
  }
  return {
    ports,
    env: { PISTACHIO_LOCAL_APP_PORTS: ports.join(",") },
    stop() {
      for (const child of children) child.kill();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
