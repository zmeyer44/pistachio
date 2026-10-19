import { createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";

/**
 * A real LiveKit SFU for the live-share specs (docs/live-share.md §12): a
 * `livekit-server` of the spec's own on free ports, with a generated key, and
 * the two things control does with LiveKit — minting participant tokens and
 * sending server data (a knock) — done here with node:crypto and fetch, so a
 * spec needs neither control nor the server SDK.
 *
 * Without the binary on PATH (`brew install livekit`), `startLiveKit` skips
 * the calling test with that reason.
 */

/** LiveKit's VideoGrant, as far as live share uses it (§3). */
export interface LiveKitGrants {
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canPublishData?: boolean;
  canSubscribe?: boolean;
  canPublishSources?: Array<"camera" | "microphone" | "screen_share" | "screen_share_audio">;
  canUpdateOwnMetadata?: boolean;
  roomAdmin?: boolean;
}

export interface LiveKitServer {
  /** The URL clients connect to (`ws://127.0.0.1:<port>`). */
  url: string;
  /** The server API's base (`http://127.0.0.1:<port>`). */
  httpUrl: string;
  apiKey: string;
  apiSecret: string;
  /** A participant token: `metadata` is the JSON string control would set; ttl in seconds (default 10 min). */
  mintToken(identity: string, name: string, metadata: string, grants: LiveKitGrants, ttlSeconds?: number): string;
  /** Data from the server (no participant), as control sends `lv.knock`. */
  sendData(room: string, topic: string, payload: Uint8Array, destinationIdentities?: string[]): Promise<void>;
  stop(): Promise<void>;
}

/** The `livekit-server` on PATH, or null. */
export function livekitServerPath(): string | null {
  const found = spawnSync("/usr/bin/which", ["livekit-server"], { encoding: "utf8" });
  const path = found.status === 0 ? found.stdout.trim() : "";
  return path === "" ? null : path;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** Spawn a LiveKit server on free loopback ports; resolves once its HTTP answers. */
export async function startLiveKit(): Promise<LiveKitServer> {
  const binary = livekitServerPath();
  test.skip(binary === null, "livekit-server is not on PATH (brew install livekit)");
  if (binary === null) throw new Error("unreachable");

  const [port, tcpPort, udpPort] = [await freePort(), await freePort(), await freePort()];
  const apiKey = `key_${randomBytes(6).toString("hex")}`;
  // LiveKit refuses secrets shorter than 32 characters.
  const apiSecret = randomBytes(24).toString("hex");
  const dir = await mkdtemp(join(tmpdir(), "livekit-"));
  const config = join(dir, "livekit.yaml");
  await writeFile(
    config,
    [
      `port: ${String(port)}`,
      "bind_addresses:",
      "  - 127.0.0.1",
      "rtc:",
      `  tcp_port: ${String(tcpPort)}`,
      `  udp_port: ${String(udpPort)}`,
      "  use_external_ip: false",
      "  node_ip: 127.0.0.1",
      "keys:",
      `  ${apiKey}: ${apiSecret}`,
      "logging:",
      "  level: warn",
      "",
    ].join("\n"),
  );

  const child: ChildProcess = spawn(binary, ["--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const collect = (chunk: Buffer): void => {
    log = `${log}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([once(child, "exit").then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!exited) child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  };

  const httpUrl = `http://127.0.0.1:${String(port)}`;
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`livekit-server exited with ${String(child.exitCode)}`);
      if (attempt > 150) throw new Error("livekit-server did not answer in 15 s");
      const ok = await fetch(httpUrl).then((response) => response.ok, () => false);
      if (ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await stop();
    throw new Error(`${String(error)}\n${log}`);
  }

  const mintToken = (identity: string, name: string, metadata: string, grants: LiveKitGrants, ttlSeconds = 600): string => {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ iss: apiKey, sub: identity, name, metadata, video: grants, nbf: now - 5, exp: now + ttlSeconds, jti: identity }, apiSecret);
  };

  const sendData = async (room: string, topic: string, payload: Uint8Array, destinationIdentities: string[] = []): Promise<void> => {
    const admin = mintToken("server", "server", "", { room, roomAdmin: true }, 60);
    const response = await fetch(`${httpUrl}/twirp/livekit.RoomService/SendData`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        room,
        data: Buffer.from(payload).toString("base64"),
        kind: "RELIABLE",
        destination_identities: destinationIdentities,
        topic,
      }),
    });
    if (!response.ok) throw new Error(`SendData answered ${String(response.status)}: ${await response.text()}`);
  };

  return { url: `ws://127.0.0.1:${String(port)}`, httpUrl, apiKey, apiSecret, mintToken, sendData, stop };
}
