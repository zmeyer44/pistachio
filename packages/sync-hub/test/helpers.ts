import type {
  ClientMessage,
  CookieRecordWire,
  DeviceKind,
  Hlc,
  ServerMessage,
  WorkspaceRecordWire,
} from "@pistachio/sync-protocol";
import { HubCore, type HubConnection, type HubStorage } from "../src/hub-core.js";
import { MemoryHubStorage } from "../src/storage/memory.js";

export { MemoryHubStorage };

/** MemoryHubStorage with a call log, so a test can assert how many round
 * trips a handler makes and how wide its listings are. */
export class CountingHubStorage implements HubStorage {
  readonly inner = new MemoryHubStorage();
  readonly gets: string[] = [];
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  readonly lists: { prefix: string; limit: number | undefined; size: number }[] = [];

  get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key);
    return this.inner.get<T>(key);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.puts.push(key);
    return this.inner.put(key, value);
  }

  delete(key: string): Promise<boolean> {
    this.deletes.push(key);
    return this.inner.delete(key);
  }

  async list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const out = await this.inner.list<T>(options);
    this.lists.push({ prefix: options.prefix, limit: options.limit, size: out.size });
    return out;
  }

  countGets(prefix: string): number {
    return this.gets.filter((key) => key.startsWith(prefix)).length;
  }

  clearLog(): void {
    this.gets.length = 0;
    this.puts.length = 0;
    this.deletes.length = 0;
    this.lists.length = 0;
  }
}

export class FakeConnection implements HubConnection {
  private static sequence = 0;
  deviceId: string | null = null;
  kind: DeviceKind | null = null;
  connectionId = `fake-connection-${++FakeConnection.sequence}`;
  spaceIds: string[] = [];
  readonly sent: ServerMessage[] = [];
  readonly closed: { code: number; reason: string }[] = [];

  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  ofType<T extends ServerMessage["t"]>(
    t: T,
  ): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter(
      (m): m is Extract<ServerMessage, { t: T }> => m.t === t,
    );
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface Fixture {
  storage: MemoryHubStorage;
  core: HubCore;
  clock: { nowMs: number };
}

export function makeFixture(startMs = 1_000_000): Fixture {
  const storage = new MemoryHubStorage();
  const clock = { nowMs: startMs };
  const core = new HubCore(storage, () => clock.nowMs);
  return { storage, core, clock };
}

export function frame(msg: ClientMessage): string {
  return JSON.stringify(msg);
}

/** Simulate the host binding the verified token's identity to the socket —
 * what `attachSyncHub` does before any frame is read. */
export function bind(
  conn: FakeConnection,
  deviceId: string,
  kind: DeviceKind = "desktop",
): FakeConnection {
  conn.deviceId = deviceId;
  conn.kind = kind;
  return conn;
}

/** Bind the connection as the host would, then dispatch a matching hello. */
export async function sendHello(
  core: HubCore,
  conn: FakeConnection,
  deviceId: string,
  spaceIds: string[],
  others: FakeConnection[] = [],
  kind: DeviceKind = "desktop",
): Promise<void> {
  bind(conn, deviceId, kind);
  await core.handleMessage(
    conn,
    frame({ t: "hello", deviceId, kind, spaceIds }),
    others,
  );
}

export function hex64(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

let recordSeq = 0;

export function makeRecord(
  overrides: Partial<CookieRecordWire> & { spaceId: string; hlc: Hlc },
): CookieRecordWire {
  recordSeq += 1;
  return {
    recordId: hex64(recordSeq),
    originId: hex64(0xabcdef),
    sealedRecord: "c2VhbGVk",
    causalParent: null,
    deviceSig: "c2ln",
    cause: "WRITE",
    ...overrides,
  };
}

export function makeWorkspaceDoc(
  overrides: Partial<WorkspaceRecordWire> & { key: string; hlc: Hlc },
): WorkspaceRecordWire {
  return {
    sealedValue: "c2VhbGVk",
    deviceSig: "c2ln",
    ...overrides,
  };
}

export function makeHlc(
  physicalMs: number,
  deviceId = "dev-a",
  logical = 0,
): Hlc {
  return { physicalMs, logical, deviceId };
}
