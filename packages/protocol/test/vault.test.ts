import { describe, expect, it } from "vitest";
import {
  isVaultStorableField,
  matchVaultEntry,
  selectVaultEntry,
  vaultEntrySuperseded,
  vaultFieldKey,
  vaultFieldKeys,
  type VaultEntry,
} from "../src/index.js";

const entry = (id: string, updatedAt: string, fields: VaultEntry["fields"]): VaultEntry => ({
  id,
  spaceId: "work",
  siteOrigin: "https://www.example.com",
  siteName: "Example",
  fields,
  source: "capture",
  sealedPayload: "AQ==",
  createdAt: updatedAt,
  updatedAt,
  lastUsedAt: null,
});

describe("vault field matching", () => {
  it("keys fields by purpose, so a username and an email input are the same sign-in id", () => {
    expect(vaultFieldKey({ type: "text", label: "Email or phone", autocomplete: "username" })).toBe("login-id");
    expect(vaultFieldKey({ type: "email", label: "Email" })).toBe("login-id");
    expect(vaultFieldKey({ type: "password", label: "Your password" })).toBe("password");
    expect(vaultFieldKey({ type: "password", label: "Password", autocomplete: "current-password" })).toBe("password");
    expect(vaultFieldKey({ type: "text", label: "Card number", autocomplete: "cc-number" })).toBe("ac:cc-number");
    expect(vaultFieldKey({ type: "text", label: " Loyalty  Number! " })).toBe("text:loyalty number");
    expect(vaultFieldKeys([
      { type: "password", label: "Password" },
      { type: "email", label: "Email" },
      { type: "text", label: "Email", autocomplete: "username" },
    ])).toEqual(["login-id", "password"]);
  });

  it("never keeps a one-time code", () => {
    expect(isVaultStorableField({ type: "otp" })).toBe(false);
    expect(isVaultStorableField({ type: "text", autocomplete: "one-time-code" })).toBe(false);
    expect(isVaultStorableField({ type: "password", autocomplete: "current-password" })).toBe(true);
  });

  it("fills a whole request from a saved entry or none of it", () => {
    const saved: VaultEntry["fields"] = [
      { id: "a", label: "Email", type: "email", autocomplete: "email" },
      { id: "b", label: "Password", type: "password", autocomplete: "current-password" },
      { id: "c", label: "Card number", type: "text", autocomplete: "cc-number" },
    ];
    const login = matchVaultEntry(
      [
        { label: "Email address", type: "text", autocomplete: "username" },
        { label: "Password", type: "password" },
      ],
      saved,
    );
    expect(login?.map((pair) => pair.saved.id)).toEqual(["a", "b"]);
    expect(matchVaultEntry([{ label: "Security code", type: "text", autocomplete: "cc-csc" }], saved)).toBeNull();
    expect(matchVaultEntry(
      [{ label: "Password", type: "password" }, { label: "Code", type: "otp", autocomplete: "one-time-code" }],
      saved,
    )).toBeNull();
    expect(matchVaultEntry([{ label: "Password", type: "password" }, { label: "PIN", type: "password" }], saved)).toBeNull();
    expect(matchVaultEntry([], saved)).toBeNull();
  });

  it("prefers the newest matching entry and skips ones a run already tried", () => {
    const old = entry("old", "2026-01-01T00:00:00.000Z", [{ id: "p", label: "Password", type: "password" }]);
    const fresh = entry("fresh", "2026-02-01T00:00:00.000Z", [
      { id: "e", label: "Email", type: "email" },
      { id: "p", label: "Password", type: "password" },
    ]);
    const request = [{ label: "Password", type: "password" as const }];
    expect(selectVaultEntry(request, [old, fresh])?.entry.id).toBe("fresh");
    expect(selectVaultEntry(request, [old, fresh], new Set(["fresh"]))?.entry.id).toBe("old");
    expect(selectVaultEntry(request, [old, fresh], new Set(["fresh", "old"]))).toBeNull();
  });

  it("supersedes an older entry only when the newer one covers every purpose it had", () => {
    const login = entry("login", "2026-01-01T00:00:00.000Z", [
      { id: "e", label: "Email", type: "email" },
      { id: "p", label: "Password", type: "password" },
    ]);
    const passwordOnly = entry("pw", "2026-02-01T00:00:00.000Z", [{ id: "p", label: "Password", type: "password" }]);
    const card = entry("card", "2026-02-01T00:00:00.000Z", [{ id: "c", label: "Card", type: "text", autocomplete: "cc-number" }]);
    expect(vaultEntrySuperseded(passwordOnly, login)).toBe(true);
    expect(vaultEntrySuperseded(login, passwordOnly)).toBe(false);
    expect(vaultEntrySuperseded(card, login)).toBe(false);
  });
});
