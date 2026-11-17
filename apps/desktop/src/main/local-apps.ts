/**
 * Local apps (docs/local-apps.md): which ports on this Mac serve a web app,
 * for the address bar's chips.
 *
 * A scan asks the OS what is listening (`lsof`), drops what is Pistachio's
 * own, and asks each of the rest for its front page over loopback: what
 * answers with HTML is an app. Its title and icon come from that page; its
 * project, folder and server from its process (`ps`, its working folder).
 * Nothing leaves the machine, and the shell is handed only the result — an
 * icon travels as a data: URL, so no shell page ever fetches from a port.
 *
 * Without `lsof` (or when it fails) the scan falls back to the usual
 * dev-server ports, and knows nothing of their processes.
 *
 * Under PISTACHIO_E2E only the ports in PISTACHIO_LOCAL_APP_PORTS (a comma
 * list) are looked at, so a spec sees its own servers and none of the
 * machine's.
 *
 * The parsing is pure, so vitest pins it under node (test/local-apps.test.ts).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LocalApp } from "@pistachio/shell-contracts/local-apps";

/** Ports dev servers usually take, looked at when the OS cannot say what is listening. */
export const COMMON_DEV_PORTS = [3000, 3001, 3002, 3003, 4000, 4200, 4321, 4173, 5000, 5173, 5174, 5175, 6006, 8000, 8080, 8081, 8888, 9000] as const;

/** A listing is reused this long: the bar opening twice in a breath scans once. */
const LIST_TTL_MS = 1_500;
/** A port that answered with something other than a page is not asked again for this long. */
const NOT_AN_APP_TTL_MS = 60_000;
/**
 * A port that took a connection and said nothing in time is not asked again
 * for this long: most are not web servers at all (an editor's helper, a
 * database), and the few that are (a dev server compiling) answer by then.
 */
const SILENT_TTL_MS = 20_000;
const PROBE_TIMEOUT_MS = 900;
const ICON_TIMEOUT_MS = 700;
const MAX_PAGE_BYTES = 96 * 1024;
const MAX_ICON_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TITLE_LENGTH = 120;

/** One socket listening for connections, as `lsof -F pcn` reports it. */
export interface Listener {
  pid: number;
  /** The process's short name (`lsof`'s `c`). */
  command: string;
  port: number;
  /** The host to reach it on: 127.0.0.1, or [::1] for a socket bound to IPv6 loopback alone. */
  host: string;
  /**
   * Where to try when `host` refuses: [::1], for an IPv6 socket bound to every
   * address — it may take IPv6 alone (`ipv6Only`), which lsof does not say.
   */
  fallbackHost?: string;
}

/**
 * The listening sockets in `lsof -nP -iTCP -sTCP:LISTEN -F pcnt` output that
 * loopback can reach — bound to every address or to loopback itself — one per
 * port (a server bound to both families is one listener).
 */
export function parseListeners(output: string): Listener[] {
  const byPort = new Map<number, Listener>();
  let pid = 0;
  let command = "";
  /** The socket's family (`t`: IPv4 or IPv6), per file. */
  let family = "";
  for (const line of output.split("\n")) {
    const field = line.charAt(0);
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
      command = "";
    } else if (field === "c") {
      command = value;
    } else if (field === "f") {
      family = "";
    } else if (field === "t") {
      family = value;
    } else if (field === "n") {
      const match = /^(.*):(\d+)$/u.exec(value);
      if (match === null || pid <= 0) continue;
      const address = match[1] ?? "";
      const port = Number(match[2]);
      const host = loopbackHostFor(address);
      if (host === null || !(port > 0 && port < 65_536)) continue;
      const everyIPv6 = address === "[::]" || (address === "*" && family === "IPv6");
      const known = byPort.get(port);
      // IPv4 loopback is the surer way in when a server is bound to both.
      if (known === undefined || (known.host === "[::1]" && host === "127.0.0.1")) {
        byPort.set(port, everyIPv6 ? { pid, command, port, host, fallbackHost: "[::1]" } : { pid, command, port, host });
      }
    }
  }
  return [...byPort.values()];
}

/** How loopback reaches a socket bound to `address`, or null when it cannot (bound to another interface). */
function loopbackHostFor(address: string): string | null {
  if (address === "*" || address === "0.0.0.0" || address === "[::]" || /^127\./u.test(address)) return "127.0.0.1";
  if (address === "[::1]") return "[::1]";
  return null;
}

/** One process, as `ps -A -o pid=,ppid=,lstart=,command=` reports it. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  startedAt: number | null;
  commandLine: string;
}

/** The processes in `ps -A -o pid=,ppid=,lstart=,command=` output, by pid. */
export function parseProcesses(output: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.split("\n")) {
    // lstart is always five words: "Tue Nov 10 07:33:16 2026".
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const started = Date.parse(match[3] ?? "");
    processes.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: Number.isFinite(started) ? started : null,
      commandLine: (match[4] ?? "").trim(),
    });
  }
  return processes;
}

/** `pid` and every process below it. */
export function descendantsOf(pid: number, processes: ReadonlyMap<number, ProcessInfo>): Set<number> {
  const children = new Map<number, number[]>();
  for (const process of processes.values()) {
    const list = children.get(process.ppid);
    if (list === undefined) children.set(process.ppid, [process.pid]);
    else list.push(process.pid);
  }
  const out = new Set<number>([pid]);
  const stack = [pid];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop() ?? -1) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** The working folders in `lsof -a -d cwd -F n -p …` output, by pid. */
export function parseWorkingFolders(output: string): Map<number, string> {
  const folders = new Map<number, string>();
  let pid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) folders.set(pid, line.slice(1));
  }
  return folders;
}

/** What serves a page, recognized from its command line — most specific first. */
const SERVERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/next-server|[\s/]next(\s|$)|\/next\/dist\//u, "Next.js"],
  [/\bvitest\b/u, "Vitest"],
  [/\bastro\b/u, "Astro"],
  [/\bnuxi?\b/u, "Nuxt"],
  [/\bremix\b/u, "Remix"],
  [/react-router\b/u, "React Router"],
  [/\bstorybook\b/u, "Storybook"],
  [/\bdocusaurus\b/u, "Docusaurus"],
  [/\bgatsby\b/u, "Gatsby"],
  [/\bexpo\b/u, "Expo"],
  [/\bwrangler\b/u, "Wrangler"],
  [/\bvite\b/u, "Vite"],
  [/react-scripts/u, "Create React App"],
  [/\bwebpack\b/u, "webpack"],
  [/\bparcel\b/u, "Parcel"],
  [/\bng\s+serve\b|@angular\/cli/u, "Angular"],
  [/\bjupyter/u, "Jupyter"],
  [/manage\.py\s+runserver/u, "Django"],
  [/\buvicorn\b/u, "Uvicorn"],
  [/\bflask\b/u, "Flask"],
  [/\bgunicorn\b/u, "Gunicorn"],
  [/http\.server/u, "Python"],
  [/\brails\b|\bpuma\b/u, "Rails"],
  [/\bhugo\b/u, "Hugo"],
  [/\bjekyll\b/u, "Jekyll"],
  [/\bphp\b/u, "PHP"],
  [/com\.docker/u, "Docker"],
  [/(^|\/)bun(\s|$)/u, "Bun"],
  [/(^|\/)deno(\s|$)/u, "Deno"],
  [/(^|\/)node(\s|$)/u, "Node"],
];

/** What serves a page: its framework when the command line names one, else the process's own name. */
export function serverOf(commandLine: string | null, processName: string | null): string | null {
  if (commandLine !== null) {
    for (const [pattern, name] of SERVERS) if (pattern.test(commandLine)) return name;
  }
  const name = processName?.trim() ?? "";
  return name.length > 0 ? name : null;
}

/**
 * What an app is part of: the app bundle its process runs from, else the
 * repository its working folder is in (the nearest folder with `.git`, short
 * of the home folder), else that folder. A process working in `/` or the home
 * folder itself (a daemon, an app's helper) says nothing about a project.
 */
export function projectOf(
  commandLine: string | null,
  folder: string | null,
  home: string,
  isRepository: (dir: string) => boolean,
): string | null {
  const bundle = commandLine === null ? null : /\/([^/]+)\.app\/Contents\//u.exec(commandLine);
  if (bundle !== null) return bundle[1] ?? null;
  if (folder === null || folder === "/" || folder === home) return null;
  for (let dir = folder; dir !== "/" && dir !== home && dir !== "."; dir = dirname(dir)) {
    if (isRepository(dir)) return basename(dir);
  }
  return basename(folder);
}

/** `folder` with the home folder as `~`. */
export function abbreviateHome(folder: string, home: string): string {
  return folder === home ? "~" : folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/** What a page's head says of it: its title and its declared icons (href as written, in order). */
export interface PageFacts {
  title: string | null;
  icons: Array<{ href: string; rel: string; sizes: string; type: string }>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A numeric reference's character; one that names none (0, a surrogate, past U+10FFFF) is U+FFFD, as HTML reads it. */
function codePoint(value: number): string {
  const valid = Number.isInteger(value) && value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff);
  return valid ? String.fromCodePoint(value) : "�";
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return codePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return codePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

/** The title and icon links in the start of a page's HTML. */
export function pageFacts(html: string): PageFacts {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const rawTitle = titleMatch === null ? "" : decodeEntities(titleMatch[1] ?? "").replace(/\s+/gu, " ").trim();
  const title = rawTitle.length === 0 ? null : rawTitle.slice(0, MAX_TITLE_LENGTH);
  const icons: PageFacts["icons"] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = attribute(tag, "rel").toLowerCase();
    const href = attribute(tag, "href");
    if (href.length === 0 || !/(^|\s)(icon|apple-touch-icon(-precomposed)?|shortcut)(\s|$)/u.test(rel)) continue;
    icons.push({ href, rel, sizes: attribute(tag, "sizes"), type: attribute(tag, "type") });
  }
  return { title, icons };
}

/**
 * Which declared icon to show at chip size: an SVG (sharp at any size), else
 * the smallest PNG-ish icon of 32px or more, else the first icon there is.
 */
export function pickChipIcon(icons: PageFacts["icons"]): string | null {
  const plain = icons.filter((icon) => !icon.rel.includes("apple-touch-icon") && !icon.rel.includes("mask-icon"));
  const svg = plain.find((icon) => icon.type.includes("svg") || /\.svg(\?|#|$)/iu.test(icon.href));
  if (svg !== undefined) return svg.href;
  const side = (sizes: string): number => Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/giu)].map((m) => Number(m[1])));
  const sized = plain.filter((icon) => side(icon.sizes) >= 32).sort((a, b) => side(a.sizes) - side(b.sizes));
  return sized[0]?.href ?? plain[0]?.href ?? icons[0]?.href ?? null;
}

/** Whether a response is a page: a 2xx whose content type (or, without one, whose start) is HTML. */
export function isPage(status: number, contentType: string | undefined, start: string): boolean {
  if (status < 200 || status >= 300) return false;
  if (contentType !== undefined && contentType.length > 0) return /text\/html|application\/xhtml/iu.test(contentType);
  return /^\s*(<!doctype html|<html)/iu.test(start);
}

interface Fetched {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One GET for `asked`, its connection made to `through` (a loopback address)
 * whatever host `asked` names — which the server hears as the Host — reading
 * at most `maxBytes` of its body, all within `timeoutMs`: a body still
 * arriving then (a stream) is cut where it got to, and a server that has not
 * answered at all fails with "timeout".
 */
function get(asked: URL, through: string, timeoutMs: number, maxBytes: number): Promise<Fetched> {
  const url = new URL(asked);
  url.hostname = through;
  return new Promise((resolve, reject) => {
    let finish: (() => void) | null = null;
    const deadline = setTimeout(() => {
      if (finish !== null) finish();
      else request.destroy(new Error("timeout"));
    }, timeoutMs);
    const options = {
      headers: {
        accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
        "user-agent": "Pistachio local apps",
        ...(asked.host === url.host ? {} : { host: asked.host }),
      },
    };
    const onResponse = (response: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (): void => {
        clearTimeout(deadline);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
        response.destroy();
      };
      finish = done;
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= maxBytes) done();
      });
      response.on("end", done);
      response.on("error", done);
    };
    // A local server's certificate is its own, and nothing sent here is a secret.
    const request = url.protocol === "https:" ? https.get(url, { ...options, rejectUnauthorized: false }, onResponse) : http.get(url, options, onResponse);
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}

/** Whether a failed request means nothing listens there (an IPv6-only socket asked over IPv4). */
function refused(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "EADDRNOTAVAIL";
}

/** Whether a failed http request means the port speaks TLS (it answered, but not in HTTP). */
function spokeSomethingElse(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("HPE_") || code === "ECONNRESET");
}

interface Probed {
  /** The page's address as the server knows it: the host a redirect named, which it is asked for by. */
  url: URL;
  /** The loopback address its connections go to. */
  through: string;
  facts: PageFacts;
}

/**
 * The port's front page, following its redirects on the same port — "none"
 * when it does not serve one, "slow" when it did not answer in time (a dev
 * server compiling its first page: asked again on the next scan).
 *
 * Every connection goes to the listener's loopback address. A redirect may
 * name this Mac another way (127.0.0.1 → localhost, the server's own name for
 * itself): that name is what the server is asked by from then on, as the
 * Host it hears, never a host looked up anew.
 */
async function probe(listener: Pick<Listener, "host" | "fallbackHost" | "port">): Promise<Probed | "none" | "slow"> {
  const { port } = listener;
  let through = listener.host;
  let asked = new URL(`http://${through}:${port}/`);
  let triedTls = false;
  let triedFallback = false;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Fetched;
    try {
      response = await get(asked, through, PROBE_TIMEOUT_MS, MAX_PAGE_BYTES);
    } catch (error) {
      if (hop === 0 && !triedFallback && listener.fallbackHost !== undefined && refused(error)) {
        triedFallback = true;
        through = listener.fallbackHost;
        asked = new URL(`${asked.protocol}//${through}:${port}/`);
        hop--;
        continue;
      }
      if (!triedTls && hop === 0 && spokeSomethingElse(error)) {
        triedTls = true;
        asked = new URL(`https://${through}:${port}/`);
        hop--;
        continue;
      }
      if (!isTimeout(error)) return "none";
      // Sent on by a redirect, it is an app that is only slow to draw the page: nameless for now.
      return hop === 0 ? "slow" : { url: new URL("/", asked), through, facts: { title: null, icons: [] } };
    }
    // An HTTPS server asked in plain HTTP often answers in HTTP all the same,
    // with a 400 (nginx's "The plain HTTP request was sent to HTTPS port", Go's
    // and Caddy's "Client sent an HTTP request to an HTTPS server"): its port
    // is asked once more, over TLS. A plain server's own 400 then fails the
    // handshake, and is no page either way.
    if (response.status === 400 && hop === 0 && !triedTls && asked.protocol === "http:") {
      triedTls = true;
      asked = new URL(`https://${through}:${port}/`);
      hop--;
      continue;
    }
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === "string") {
      let next: URL;
      try {
        next = new URL(location, asked);
      } catch {
        return "none";
      }
      if (localPort(next) !== port || (next.protocol !== "http:" && next.protocol !== "https:")) return "none";
      // Its scheme (a server sending plain HTTP on to HTTPS), loopback name,
      // path and query are taken, set on the address already asked — never
      // read again as a reference, where `//host/…` would name another host —
      // so the port stays, and the connection the loopback address.
      const followed = new URL(asked);
      followed.protocol = next.protocol;
      followed.hostname = next.hostname;
      followed.pathname = next.pathname;
      followed.search = next.search;
      if (localPort(followed) !== port) return "none";
      asked = followed;
      continue;
    }
    const start = response.body.toString("utf8");
    if (!isPage(response.status, response.headers["content-type"], start.slice(0, 512))) return "none";
    return { url: asked, through, facts: pageFacts(start) };
  }
  return "none";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout";
}

function localPort(url: URL): number | null {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/u.test(url.hostname)) return null;
  return url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
}

/** The page's icon (or the port's /favicon.ico) as a data: URL, or null. */
async function iconOf(page: Probed): Promise<string | null> {
  const declared = pickChipIcon(page.facts.icons);
  const candidates: URL[] = [];
  if (declared !== null) {
    try {
      const resolved = new URL(declared, page.url);
      if (resolved.protocol === "data:") return resolved.href.length <= MAX_ICON_BYTES * 1.4 ? resolved.href : null;
      if (resolved.origin === page.url.origin) candidates.push(resolved);
    } catch {
      // An unreadable href: try the conventional place instead.
    }
  }
  candidates.push(new URL("/favicon.ico", page.url));
  for (const candidate of candidates) {
    try {
      const response = await get(candidate, page.through, ICON_TIMEOUT_MS, MAX_ICON_BYTES + 1);
      const type = String(response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      if (response.status !== 200 || response.body.length === 0 || response.body.length > MAX_ICON_BYTES) continue;
      if (!type.startsWith("image/")) continue;
      return `data:${type};base64,${response.body.toString("base64")}`;
    } catch {
      // The next candidate, if any.
    }
  }
  return null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when one of several pids is gone; what it printed still counts.
      if (error !== null && stdout.length === 0) reject(error);
      else resolve(stdout);
    });
  });
}

/** The ports a spec named for itself (PISTACHIO_LOCAL_APP_PORTS), under e2e; null otherwise. */
function e2ePorts(): Set<number> | null {
  if (process.env.PISTACHIO_E2E === undefined) return null;
  const listed = (process.env.PISTACHIO_LOCAL_APP_PORTS ?? "").split(",").map((port) => Number(port.trim()));
  return new Set(listed.filter((port) => Number.isInteger(port) && port > 0));
}

/** The dev server's own port when the shell itself is served by one (`pnpm dev`). */
function ownRendererPort(): number | null {
  const served = process.env.ELECTRON_RENDERER_URL;
  if (served === undefined) return null;
  try {
    return localPort(new URL(served));
  } catch {
    return null;
  }
}

interface Known {
  /** Null: the port answered, but not with a page — or, `silent`, did not answer in time. */
  app: LocalApp | null;
  at: number;
  silent?: boolean;
}

export class LocalApps {
  #listing: Promise<LocalApp[]> | null = null;
  #listedAt = 0;
  #last: LocalApp[] = [];
  /** What each listener turned out to be, keyed by pid and port: a restarted server is a new key. */
  #known = new Map<string, Known>();
  readonly #home = homedir();
  /** Whose process tree is Pistachio's own, never offered: this process, unless a test says otherwise. */
  readonly #ownPid: number;

  constructor(options: { ownPid?: number } = {}) {
    this.#ownPid = options.ownPid ?? process.pid;
  }

  /** The web apps on this Mac's ports, newest first. */
  list(): Promise<LocalApp[]> {
    if (this.#listing !== null) return this.#listing;
    if (Date.now() - this.#listedAt < LIST_TTL_MS) return Promise.resolve(this.#last);
    this.#listing = this.#scan()
      .catch(() => this.#last)
      .then((apps) => {
        this.#last = apps;
        this.#listedAt = Date.now();
        this.#listing = null;
        return apps;
      });
    return this.#listing;
  }

  async #scan(): Promise<LocalApp[]> {
    const only = e2ePorts();
    const ownPort = ownRendererPort();
    let listeners: Listener[];
    let processes = new Map<number, ProcessInfo>();
    try {
      listeners = parseListeners(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnt"]));
      processes = parseProcesses(await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,command="]));
    } catch {
      listeners = COMMON_DEV_PORTS.map((port) => ({ pid: 0, command: "", port, host: "127.0.0.1" }));
    }
    const own = descendantsOf(this.#ownPid, processes);
    const candidates = listeners.filter(
      (listener) => !own.has(listener.pid) && listener.port !== ownPort && (only === null || only.has(listener.port)),
    );
    const pids = [...new Set(candidates.map((listener) => listener.pid).filter((pid) => pid > 0))];
    const folders = pids.length === 0 ? new Map<number, string>() : await run("lsof", ["-a", "-d", "cwd", "-F", "n", "-p", pids.join(",")]).then(parseWorkingFolders, () => new Map<number, string>());

    const now = Date.now();
    const live = new Set<string>();
    // Each port on its own: one that fails in a way not foreseen costs its own
    // app, never the whole list (list() would keep the last answer for good).
    const apps = await Promise.all(
      candidates.map(async (listener): Promise<LocalApp | null> => {
        const key = `${listener.pid}:${listener.port}`;
        live.add(key);
        try {
          return await this.#examine(listener, key, processes, folders, now);
        } catch {
          return null;
        }
      }),
    );
    for (const key of this.#known.keys()) if (!live.has(key)) this.#known.delete(key);
    return apps
      .filter((app): app is LocalApp => app !== null)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.port - b.port);
  }

  /** What one listener is: its app, or null when it serves none (remembered a while, so it is not asked on every scan). */
  async #examine(
    listener: Listener,
    key: string,
    processes: Map<number, ProcessInfo>,
    folders: Map<number, string>,
    now: number,
  ): Promise<LocalApp | null> {
    const known = this.#known.get(key);
    if (known !== undefined && known.app === null && now - known.at < (known.silent ? SILENT_TTL_MS : NOT_AN_APP_TTL_MS)) return null;
    const page = await probe(listener);
    if (page === "slow") {
      // As it was last time, if it was an app then; else left alone a while.
      if (known?.app != null) return known.app;
      this.#known.set(key, { app: null, at: now, silent: true });
      return null;
    }
    if (page === "none") {
      this.#known.set(key, { app: null, at: now });
      return null;
    }
    const info = processes.get(listener.pid) ?? null;
    const folder = folders.get(listener.pid) ?? null;
    // The app's root, which its own redirect takes it on from (not the sign-in page it led to).
    const url = `${page.url.protocol}//localhost:${listener.port}/`;
    const app: LocalApp = {
      url,
      port: listener.port,
      title: page.facts.title,
      // The icon of a server that is still the same process is kept: it rarely changes.
      iconUrl: known?.app?.iconUrl ?? (await iconOf(page)),
      project: projectOf(info?.commandLine ?? null, folder, this.#home, (dir) => existsSync(join(dir, ".git"))),
      folder: folder === null || folder === "/" ? null : abbreviateHome(folder, this.#home),
      server: serverOf(info?.commandLine ?? null, listener.command || null),
      startedAt: info?.startedAt ?? null,
    };
    this.#known.set(key, { app, at: now });
    return app;
  }
}
