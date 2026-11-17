/**
 * The address bar's tray of local apps (src/lib/local-tray.ts): what a pill
 * is called, which apps a query reaches, how one project's ports group, and
 * the line that tells a chosen one apart — on the kind of data a real Mac
 * has: one project on four ports, odd titles, no title at all.
 */

import { describe, expect, it } from "vitest";
import type { LocalApp } from "@pistachio/shell-contracts/local-apps";
import { localAppDetail, localAppMatches, localAppName, trayGroups, uptime } from "../src/lib/local-tray";

const NOW = Date.UTC(2026, 10, 10, 12);

function app(port: number, fields: Partial<LocalApp> = {}): LocalApp {
  return {
    url: `http://localhost:${port}/`,
    port,
    title: null,
    iconUrl: null,
    project: null,
    folder: null,
    server: null,
    startedAt: null,
    ...fields,
  };
}

// The owner's Mac, newest first.
const MARIUS = [5243, 5242, 5231, 5173].map((port, i) =>
  app(port, { title: "Marius", project: "marius", server: "Vite", startedAt: NOW - (i + 1) * 3_600_000 }),
);
const EMILY = app(3000, { title: "Sign in · emily", project: "emilylevy", server: "Next.js", startedAt: NOW - 5 * 86_400_000 });
const BUBBLES = app(1234, { title: "BlueBubbles Server", project: "BlueBubbles", server: "BlueBubbles" });
const SCRATCH = app(4821, { project: "scratch", server: "Node", startedAt: NOW - 20_000 });
const ORPHAN = app(8080);

const ports = (apps: LocalApp[], query: string) => apps.filter((candidate) => localAppMatches(candidate, query)).map((match) => match.port);
const ALL = [...MARIUS, EMILY, BUBBLES, SCRATCH];

describe("localAppName", () => {
  it("leads with the project, then the title, then the server", () => {
    expect(localAppName(MARIUS[0]!)).toBe("marius");
    expect(localAppName(app(1, { title: "Swagger UI", server: "Uvicorn" }))).toBe("Swagger UI");
    expect(localAppName(app(1, { server: "Node" }))).toBe("Node");
    expect(localAppName(ORPHAN)).toBe("localhost");
  });
});

describe("localAppMatches", () => {
  it("takes digits as a port being typed, from its start", () => {
    expect(ports(ALL, "5")).toEqual([5243, 5242, 5231, 5173]);
    expect(ports(ALL, "52")).toEqual([5243, 5242, 5231]);
    expect(ports(ALL, "5173")).toEqual([5173]);
    expect(ports(ALL, "73")).toEqual([]);
  });

  it("takes an address of this Mac, with or without its port", () => {
    expect(ports(ALL, ":3000")).toEqual([3000]);
    expect(ports(ALL, ":")).toHaveLength(ALL.length);
    expect(ports(ALL, "localhost")).toHaveLength(ALL.length);
    expect(ports(ALL, "loc")).toHaveLength(ALL.length);
    expect(ports(ALL, "localhost:12")).toEqual([1234]);
    expect(ports(ALL, "127.0.0.1:3000")).toEqual([3000]);
    expect(ports(ALL, "http://localhost:3000/signin")).toEqual([3000]);
    expect(ports(ALL, "LOCALHOST:5173/")).toEqual([5173]);
    expect(ports(ALL, "example.com:3000")).toEqual([]);
  });

  it("takes words that begin the name, the title or the server", () => {
    expect(ports(ALL, "mar")).toEqual([5243, 5242, 5231, 5173]);
    expect(ports(ALL, "marius 52")).toEqual([5243, 5242, 5231]);
    expect(ports(ALL, "emily")).toEqual([3000]);
    expect(ports(ALL, "sign in")).toEqual([3000]);
    expect(ports(ALL, "next")).toEqual([3000]);
    expect(ports(ALL, "blue")).toEqual([1234]);
    expect(ports(ALL, "vite")).toEqual([5243, 5242, 5231, 5173]);
    expect(ports(ALL, "rius")).toEqual([]);
    expect(ports(ALL, "github.com")).toEqual([]);
  });

  it("matches everything before anything is typed", () => {
    expect(ports(ALL, "  ")).toHaveLength(ALL.length);
  });
});

describe("trayGroups", () => {
  it("puts one project's ports in one pill, lowest port first, where its newest falls", () => {
    const groups = trayGroups([MARIUS[0]!, EMILY, MARIUS[1]!, BUBBLES, MARIUS[2]!, MARIUS[3]!, SCRATCH]);
    expect(groups.map((group) => [group.name, group.apps.map((member) => member.port)])).toEqual([
      ["marius", [5173, 5231, 5242, 5243]],
      ["emilylevy", [3000]],
      ["BlueBubbles", [1234]],
      ["scratch", [4821]],
    ]);
  });

  it("leaves apps with nothing to share apart", () => {
    expect(trayGroups([ORPHAN, app(9090)]).map((group) => group.apps.length)).toEqual([1, 1]);
    expect(trayGroups([app(1, { title: "Docs" }), app(2, { title: "Docs" })]).map((group) => group.apps.length)).toEqual([2]);
  });
});

describe("uptime and the detail line", () => {
  it("says how long in as few characters as do", () => {
    expect(uptime(null, NOW)).toBeNull();
    expect(uptime(NOW - 20_000, NOW)).toBe("just started");
    expect(uptime(NOW - 12 * 60_000, NOW)).toBe("up 12 min");
    expect(uptime(NOW - 3 * 3_600_000, NOW)).toBe("up 3 h");
    expect(uptime(NOW - 50 * 3_600_000, NOW)).toBe("up 2 d");
  });

  it("says what the pill does not: the server, a title that is not the name again, the uptime", () => {
    expect(localAppDetail(MARIUS[0]!, NOW)).toBe("Vite · up 1 h");
    expect(localAppDetail(EMILY, NOW)).toBe("Next.js · Sign in · emily · up 5 d");
    expect(localAppDetail(BUBBLES, NOW)).toBe("BlueBubbles Server");
    expect(localAppDetail(SCRATCH, NOW)).toBe("Node · just started");
    expect(localAppDetail(app(1, { title: "Storybook", server: "Storybook", project: "design-system" }), NOW)).toBe("Storybook");
    expect(localAppDetail(app(1, { title: "Vite + React + TS", server: "Vite", project: "playground" }), NOW)).toBe("Vite + React + TS");
  });
});
