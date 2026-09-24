import { describe, expect, it } from "vitest";
import { LinkedSession } from "../../src/sessions/linked-session.js";

describe("linked device control", () => {
  it("fences all old controller input across handoffs and unlinking", () => {
    const link = new LinkedSession();
    link.join("desktop"); link.join("web");
    expect(link.change("desktop", "enable", 0)).toBe(true);
    expect(link.mayDrive("desktop", 1)).toBe(true);
    expect(link.mayDrive("web", 1)).toBe(false);
    expect(link.mayDrive("desktop")).toBe(false);
    expect(link.change("web", "disable", 1)).toBe(false);
    expect(link.change("web", "take-control", 0)).toBe(false);
    expect(link.change("web", "take-control", 1)).toBe(true);
    expect(link.mayDrive("desktop", 1)).toBe(false);
    expect(link.mayDrive("web", 2)).toBe(true);
    expect(link.change("web", "disable", 2)).toBe(true);
    expect(link.mayDrive("web", 2)).toBe(false);
    expect(link.mayDrive("desktop", 3)).toBe(true);
  });
  it("hands control to a proved remaining viewer on disconnect", () => {
    const link = new LinkedSession();
    link.join("desktop"); link.join("web");
    link.change("desktop", "enable", 0);
    link.leave("desktop");
    expect(link.state).toEqual({ enabled: true, generation: 2, controller: "web", viewers: ["web"] });
    expect(link.mayDrive("desktop", 2)).toBe(false);
    expect(link.mayDrive("web", 1)).toBe(false);
    expect(link.mayDrive("web", 2)).toBe(true);
    expect(link.change("stranger", "take-control", 2)).toBe(false);
  });
});
