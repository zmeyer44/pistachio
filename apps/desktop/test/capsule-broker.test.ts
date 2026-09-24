import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cookie, Session } from "electron";
import { CapsuleBroker } from "../src/main/capsule-broker";
import type { CapturedPageContext } from "../src/main/browser-controller";
import type { BrowserTabInfo } from "@pistachio/shell-contracts/ipc";

const capturedAt = new Date("2026-08-24T12:00:00Z");
const tab: BrowserTabInfo = {
  id: "tab-1",
  spaceId: "work",
  title: "Invoice",
  url: "https://finance.example/invoices/1",
  faviconUrl: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  kind: "human",
  runId: null,
  anchorId: null,
  lifecycle: "live",
  lastActiveAt: capturedAt.getTime(),
  unlisted: false,
};
const context: CapturedPageContext = {
  selectedText: "private purchase order notes",
  formState: [
    { name: "memo", type: "textarea", value: "freight variance" },
    { name: "password", type: "password", value: "must-remain-sealed" },
  ],
};

function cookie(overrides: Partial<Cookie>): Cookie {
  return {
    name: "session",
    value: "secret-cookie",
    domain: "finance.example",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
    ...overrides,
  };
}

function sourceSession(cookies: Cookie[]): Session {
  return {
    cookies: { get: vi.fn().mockResolvedValue(cookies) },
  } as unknown as Session;
}

afterEach(() => vi.useRealTimers());

describe("capsule broker", () => {
  it("seals page context and preserves host-only cookie identity during hydration", async () => {
    const broker = new CapsuleBroker();
    const capsule = await broker.capture({
      taskId: "task-1",
      sponsorId: "user-1",
      purpose: "Reconcile invoice",
      tab,
      context,
      sourceSession: sourceSession([
        cookie({ name: "host", hostOnly: true }),
        cookie({ name: "domain", domain: ".finance.example", hostOnly: false }),
      ]),
      now: capturedAt,
    });

    const publicCapsule = JSON.stringify(capsule);
    expect(publicCapsule).not.toContain("private purchase order notes");
    expect(publicCapsule).not.toContain("must-remain-sealed");
    expect(publicCapsule).not.toContain("secret-cookie");

    const set = vi.fn().mockResolvedValue(undefined);
    const hydrated = await broker.hydrate(
      capsule.id,
      { cookies: { set } } as unknown as Session,
      capturedAt.getTime() + 1,
    );
    expect(hydrated).toEqual(context);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0]?.[0]).not.toHaveProperty("domain");
    expect(set.mock.calls[1]?.[0]).toMatchObject({ domain: ".finance.example" });
  });

  it("actively destroys capsule material when its TTL elapses", async () => {
    vi.useFakeTimers();
    const broker = new CapsuleBroker();
    const onExpired = vi.fn();
    broker.onExpired(onExpired);
    const capsule = await broker.capture({
      taskId: "task-1",
      sponsorId: "user-1",
      purpose: "Reconcile invoice",
      tab,
      context,
      sourceSession: sourceSession([]),
      now: capturedAt,
      ttlMs: 1_000,
    });
    expect(broker.isLive(capsule.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(broker.isLive(capsule.id)).toBe(false);
    expect(onExpired).toHaveBeenCalledWith(capsule.id);
    await expect(
      broker.hydrate(capsule.id, { cookies: { set: vi.fn() } } as unknown as Session),
    ).rejects.toThrow("revoked, expired, or unknown");
  });
});
