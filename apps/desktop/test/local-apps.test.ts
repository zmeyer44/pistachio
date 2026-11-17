/**
 * Which local ports are web apps, and what they are called
 * (src/main/local-apps.ts, docs/local-apps.md).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abbreviateHome,
  descendantsOf,
  isPage,
  LocalApps,
  pageFacts,
  parseListeners,
  parseProcesses,
  parseWorkingFolders,
  pickChipIcon,
  projectOf,
  serverOf,
} from "../src/main/local-apps";
import { localPortOf } from "@pistachio/shell-contracts/local-apps";

describe("the listening sockets", () => {
  it("keeps what loopback reaches, one listener a port, IPv4 first", () => {
    const output = [
      "p656", "cBlueBubbles", "f61", "n*:1234", "f79", "n[::1]:45670",
      "p689", "cControlCenter", "f9", "n*:7000",
      "p900", "cnode", "f13", "n[::1]:5173", "f14", "n127.0.0.1:5173",
      "p901", "cnode", "f13", "n192.168.1.20:8080",
      "p902", "cpython3", "f3", "n[::]:8000",
    ].join("\n");
    expect(parseListeners(output)).toEqual([
      { pid: 656, command: "BlueBubbles", port: 1234, host: "127.0.0.1" },
      { pid: 656, command: "BlueBubbles", port: 45670, host: "[::1]" },
      { pid: 689, command: "ControlCenter", port: 7000, host: "127.0.0.1" },
      { pid: 900, command: "node", port: 5173, host: "127.0.0.1" },
      { pid: 902, command: "python3", port: 8000, host: "127.0.0.1", fallbackHost: "[::1]" },
    ]);
  });

  it("gives an IPv6 socket bound to every address [::1] to fall back on: it may take IPv6 alone, which lsof does not say", () => {
    const output = ["p900", "cnode", "f12", "tIPv6", "n*:5173", "p901", "cpython3", "f3", "tIPv4", "n*:8000"].join("\n");
    expect(parseListeners(output)).toEqual([
      { pid: 900, command: "node", port: 5173, host: "127.0.0.1", fallbackHost: "[::1]" },
      { pid: 901, command: "python3", port: 8000, host: "127.0.0.1" },
    ]);
  });
});

describe("the processes", () => {
  const output = [
    "    1     0 Tue Oct 27 06:40:00 2026     /sbin/launchd",
    "  500     1 Tue Nov 10 07:00:00 2026     /Applications/Pistachio.app/Contents/MacOS/Pistachio",
    "  501   500 Tue Nov 10 07:00:01 2026     /Applications/Pistachio.app/Contents/Frameworks/Pistachio Helper.app/Contents/MacOS/Pistachio Helper --type=utility",
    "  502   501 Tue Nov 10 07:00:02 2026     /bin/zsh -l",
    "95834 95820 Tue Nov 10 07:33:16 2026     node /Users/me/marius/node_modules/.bin/vite dev",
  ].join("\n");

  it("reads pid, parent, start and command line", () => {
    const processes = parseProcesses(output);
    expect(processes.get(95834)).toEqual({
      pid: 95834,
      ppid: 95820,
      startedAt: new Date(2026, 10, 10, 7, 33, 16).getTime(),
      commandLine: "node /Users/me/marius/node_modules/.bin/vite dev",
    });
  });

  it("finds a process's whole tree, so Pistachio's own servers are left out", () => {
    expect([...descendantsOf(500, parseProcesses(output))].sort()).toEqual([500, 501, 502]);
  });

  it("reads working folders from lsof", () => {
    expect(parseWorkingFolders("p656\nfcwd\nn/\np95834\nfcwd\nn/Users/me/marius\n")).toEqual(
      new Map([
        [656, "/"],
        [95834, "/Users/me/marius"],
      ]),
    );
  });
});

describe("what an app is", () => {
  it("names the server from its command line, else the process", () => {
    expect(serverOf("node /Users/me/marius/node_modules/.bin/vite dev", "node")).toBe("Vite");
    expect(serverOf("next-server (v16.4.3)", "node")).toBe("Next.js");
    expect(serverOf("node /Users/me/app/node_modules/.bin/vitest --ui", "node")).toBe("Vitest");
    expect(serverOf("python3 manage.py runserver", "python3")).toBe("Django");
    expect(serverOf("python3 -m http.server 8000", "python3")).toBe("Python");
    expect(serverOf("/Applications/BlueBubbles.app/Contents/MacOS/BlueBubbles", "BlueBubbles")).toBe("BlueBubbles");
    expect(serverOf(null, null)).toBeNull();
  });

  const repos = new Set(["/Users/me/pistachio"]);
  const isRepo = (dir: string): boolean => repos.has(dir);

  it("names the project: the app bundle, else the repository, else the folder", () => {
    expect(projectOf("/Applications/BlueBubbles.app/Contents/MacOS/BlueBubbles", "/", "/Users/me", isRepo)).toBe("BlueBubbles");
    expect(projectOf("node vite", "/Users/me/pistachio/apps/www", "/Users/me", isRepo)).toBe("pistachio");
    expect(projectOf("node vite", "/Users/me/scratch/demo", "/Users/me", isRepo)).toBe("demo");
    expect(projectOf("com.docker.backend", "/", "/Users/me", isRepo)).toBeNull();
    expect(projectOf("node", "/Volumes/work/x", "/Users/me", isRepo)).toBe("x");
    expect(projectOf("node", "/Users/me", "/Users/me", isRepo)).toBeNull();
    expect(abbreviateHome("/Users/me/pistachio/apps/www", "/Users/me")).toBe("~/pistachio/apps/www");
  });

  it("reads a page's title and icons", () => {
    const facts = pageFacts(`<!doctype html><html><head>
      <title>
        Marius &amp; Co &#8212; dev
      </title>
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel=icon type="image/png" sizes="16x16" href="/16.png">
      <link rel="icon" sizes="32x32" href='/32.png'>
      <link rel="stylesheet" href="/app.css">
    </head>`);
    expect(facts.title).toBe("Marius & Co — dev");
    expect(facts.icons.map((icon) => icon.href)).toEqual(["/touch.png", "/16.png", "/32.png"]);
    expect(pickChipIcon(facts.icons)).toBe("/32.png");
    expect(pickChipIcon([...facts.icons, { href: "/logo.svg", rel: "icon", sizes: "", type: "" }])).toBe("/logo.svg");
    expect(pageFacts("<html><body>hi</body></html>")).toEqual({ title: null, icons: [] });
  });

  it("counts only a 2xx HTML answer as a page", () => {
    expect(isPage(200, "text/html; charset=utf-8", "")).toBe(true);
    expect(isPage(200, undefined, "<!DOCTYPE html><html>")).toBe(true);
    expect(isPage(200, "text/plain", "")).toBe(false);
    expect(isPage(200, "text/event-stream", "")).toBe(false);
    expect(isPage(403, "text/html", "")).toBe(false);
  });

  it("matches a tab's address to a local port", () => {
    expect(localPortOf("http://localhost:5173/settings")).toBe(5173);
    expect(localPortOf("http://127.0.0.1:3000")).toBe(3000);
    expect(localPortOf("https://app.localhost/")).toBe(443);
    expect(localPortOf("http://[::1]:8080/")).toBe(8080);
    expect(localPortOf("https://example.com:3000/")).toBeNull();
    expect(localPortOf("pistachio://home")).toBeNull();
  });
});

describe("a scan", () => {
  const servers: http.Server[] = [];
  const ports: number[] = [];
  const env = { e2e: process.env.PISTACHIO_E2E, ports: process.env.PISTACHIO_LOCAL_APP_PORTS };

  const serve = async (handler: http.RequestListener): Promise<number> => {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    ports.push(port);
    return port;
  };

  beforeAll(async () => {
    await serve((request, response) => {
      if (request.url === "/") {
        response.writeHead(307, { location: "/signin" });
        response.end();
      } else if (request.url === "/signin") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<title>Sign in · Demo</title><link rel="icon" type="image/svg+xml" href="/icon.svg">');
      } else if (request.url === "/icon.svg") {
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    process.env.PISTACHIO_E2E = "1";
    process.env.PISTACHIO_LOCAL_APP_PORTS = ports.join(",");
  });

  afterAll(() => {
    for (const server of servers) server.close();
    process.env.PISTACHIO_E2E = env.e2e;
    process.env.PISTACHIO_LOCAL_APP_PORTS = env.ports;
    if (env.e2e === undefined) delete process.env.PISTACHIO_E2E;
    if (env.ports === undefined) delete process.env.PISTACHIO_LOCAL_APP_PORTS;
  });

  it("finds the port that serves a page, through its redirect, and not the one that does not", async () => {
    // The servers are this process's own, which a scan leaves out as Pistachio's.
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps).toHaveLength(1);
    const [app] = apps;
    expect(app).toMatchObject({ url: `http://localhost:${ports[0]}/`, port: ports[0], title: "Sign in · Demo", server: "Vitest" });
    expect(app?.iconUrl).toMatch(/^data:image\/svg\+xml;base64,/u);
    expect(app?.startedAt).toBeGreaterThan(0);
  });

  it("follows a redirect only on the port it was sent from: a path that reads as another host stays a path", async () => {
    // Another server of this Mac's, which the redirect below tries to send the probe to.
    let elsewhereAsked = 0;
    const elsewhere = await serve((_request, response) => {
      elsewhereAsked += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Elsewhere</title>");
    });
    const redirecting = await serve((request, response) => {
      if (request.url === "/") {
        // The same port — but its path, read again as a reference, names another host.
        response.writeHead(302, { location: `http://localhost:${redirecting}//127.0.0.1:${elsewhere}/` });
      } else {
        response.writeHead(404);
      }
      response.end();
    });
    process.env.PISTACHIO_LOCAL_APP_PORTS = String(redirecting);
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps).toEqual([]);
    expect(elsewhereAsked).toBe(0);
  });

  it("a server sending this Mac's numbered address on to its own name (127.0.0.1 → localhost) is found, the connection kept on loopback", async () => {
    const canonical = await serve((request, response) => {
      if (request.headers.host !== `localhost:${canonical}`) {
        response.writeHead(301, { location: `http://localhost:${canonical}${request.url ?? "/"}` });
        response.end();
      } else if (request.url === "/") {
        response.writeHead(302, { location: "/home" });
        response.end();
      } else if (request.url === "/home") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<title>Canonical</title><link rel="icon" href="/icon.svg">');
      } else if (request.url === "/icon.svg") {
        response.writeHead(200, { "content-type": "image/svg+xml" });
        response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    process.env.PISTACHIO_LOCAL_APP_PORTS = String(canonical);
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps.map((app) => [app.url, app.title, app.iconUrl?.startsWith("data:image/svg+xml;base64,")])).toEqual([
      [`http://localhost:${canonical}/`, "Canonical", true],
    ]);
  });

  it("a server listening on IPv6 alone is found through [::1]", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Six only</title>");
    });
    await new Promise<void>((resolve) => server.listen({ port: 0, host: "::", ipv6Only: true }, resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    process.env.PISTACHIO_LOCAL_APP_PORTS = String(port);
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps.map((app) => [app.url, app.title])).toEqual([[`http://localhost:${port}/`, "Six only"]]);
  });

  /** A throwaway self-signed certificate for localhost, or null where there is no openssl to make one. */
  const certificate = (): { key: Buffer; cert: Buffer } | null => {
    const folder = mkdtempSync(join(tmpdir(), "local-apps-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem")], { stdio: "ignore" });
      return { key: readFileSync(join(folder, "key.pem")), cert: readFileSync(join(folder, "cert.pem")) };
    } catch {
      return null;
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  /**
   * One port serving both protocols, as nginx's SSL listener or a dev proxy
   * does: a TLS handshake goes to `secure`, anything else to `plain`. Its
   * port, or null where there is no openssl to make a certificate with.
   */
  const dualProtocol = async (plain: http.RequestListener, secure: http.RequestListener): Promise<number | null> => {
    const tls = certificate();
    if (tls === null) return null;
    const secureServer = https.createServer(tls, secure);
    const plainServer = http.createServer(plain);
    const front = net.createServer((socket) => {
      socket.once("data", (start: Buffer) => {
        socket.pause();
        socket.unshift(start);
        (start[0] === 0x16 ? secureServer : plainServer).emit("connection", socket);
        process.nextTick(() => socket.resume());
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    servers.push(front as unknown as http.Server);
    return (front.address() as AddressInfo).port;
  };

  const page = (title: string): http.RequestListener => (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${title}</title>`);
  };

  it("an HTTPS server answering plain HTTP with a 400 of its own (nginx's \"plain HTTP request was sent to HTTPS port\") is asked again over TLS", async (context) => {
    const port = await dualProtocol((_request, response) => {
      response.writeHead(400, { "content-type": "text/html" });
      response.end("<title>400 The plain HTTP request was sent to HTTPS port</title>");
    }, page("Secure"));
    if (port === null) return context.skip();
    process.env.PISTACHIO_LOCAL_APP_PORTS = String(port);
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps.map((app) => [app.url, app.title])).toEqual([[`https://localhost:${port}/`, "Secure"]]);
  });

  it("a redirect from plain HTTP to HTTPS on the same port is followed over TLS", async (context) => {
    let port: number | null = null;
    port = await dualProtocol((_request, response) => {
      response.writeHead(301, { location: `https://localhost:${port}/` });
      response.end();
    }, page("Upgraded"));
    if (port === null) return context.skip();
    process.env.PISTACHIO_LOCAL_APP_PORTS = String(port);
    const apps = await new LocalApps({ ownPid: -1 }).list();
    expect(apps.map((app) => [app.url, app.title])).toEqual([[`https://localhost:${port}/`, "Upgraded"]]);
  });

  it("a page whose title cannot be read loses nothing: its numbers out of range read as �, and every other app is still found", async () => {
    expect(pageFacts("<title>&#1114112; &#x110000; &#xD800; &#0; &#99999999999999999999;</title>").title).toBe("� � � � �");
    const broken = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Broken &#1114112;</title>");
    });
    const healthy = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Healthy</title>");
    });
    process.env.PISTACHIO_LOCAL_APP_PORTS = `${broken},${healthy}`;
    const apps = await new LocalApps({ ownPid: -1 }).list();
    // One process, one start: the list is in port order, which the OS hands out as it likes.
    const expected: Array<[number, string]> = [
      [broken, "Broken �"],
      [healthy, "Healthy"],
    ];
    expect(apps.map((app) => [app.port, app.title])).toEqual(expected.sort((a, b) => a[0] - b[0]));
  });
});
