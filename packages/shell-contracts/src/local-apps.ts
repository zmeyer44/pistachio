/**
 * Local apps (docs/local-apps.md): web apps running on this Mac — a server
 * listening on a loopback port that answers with a page — offered in the
 * address bar, so a dev server is one click away. Main finds them
 * (apps/desktop/src/main/local-apps.ts); the shell only draws what it is
 * handed, and never reaches a local port itself.
 */

/** One web app on a local port. */
export interface LocalApp {
  /** Where it opens: `http://localhost:<port>/` (https when the server speaks only TLS). */
  url: string;
  port: number;
  /** The page's <title>, trimmed; null when it has none. */
  title: string | null;
  /** The page's icon as a data: URL, or null when it has none main could read. */
  iconUrl: string | null;
  /**
   * What it is part of: the repository (or folder) its server runs in, or the
   * app it belongs to (BlueBubbles.app → "BlueBubbles"); null when unknown.
   */
  project: string | null;
  /** The folder its server runs in, `~`-abbreviated; null when unknown. */
  folder: string | null;
  /** What serves it, when its command line says ("Vite", "Next.js", …), else its process's name; null when unknown. */
  server: string | null;
  /** When its server's process started (ms since the epoch), or null. The list is newest first. */
  startedAt: number | null;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * The port an address reaches on this machine — so a local app can be
 * matched to a tab already showing it — or null when it is not a local
 * address.
 */
export function localPortOf(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost") && !/^127\.\d+\.\d+\.\d+$/u.test(host)) return null;
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}
