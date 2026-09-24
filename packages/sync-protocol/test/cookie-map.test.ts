import { describe, expect, it } from "vitest";
import {
  attributesForCookie,
  cookieUrlFor,
  hostKeyIsHostOnly,
  identityForCookie,
  playwrightCookieForPlain,
  portableCookieFromCdp,
  portableCookieFromElectron,
  removeTargetFor,
  sameSiteFromChromium,
  sameSiteToChromium,
  setDetailsForPlain,
  type CdpCookie,
  type CookiePlain,
  type ElectronCookie,
  type PortableCookie,
  type SameSite,
} from "../src/index.js";

const SPACE = "space-1";

function cookie(overrides: Partial<PortableCookie> = {}): PortableCookie {
  return {
    name: "sid",
    value: "v1",
    domain: ".github.com",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    expirationDate: 1_900_000_000,
    sameSite: "lax",
    ...overrides,
  };
}

function plainFor(
  identity: Partial<CookiePlain["identity"]>,
  attributes: Partial<NonNullable<CookiePlain["attributes"]>> = {},
): CookiePlain {
  return {
    identity: {
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/",
      partitionKey: "",
      sourceScheme: "secure",
      ...identity,
    },
    attributes: {
      value: "v1",
      expiresMs: 1_900_000_000_000,
      persistent: true,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      priority: "medium",
      ...attributes,
    },
    deleted: false,
  };
}

describe("identityForCookie", () => {
  it("preserves the leading dot of a domain cookie", () => {
    const identity = identityForCookie(SPACE, cookie({ domain: ".github.com" }));
    expect(identity?.hostKey).toBe(".github.com");
    expect(hostKeyIsHostOnly(identity!.hostKey)).toBe(false);
  });

  it("keeps host-only cookies dotless", () => {
    const identity = identityForCookie(SPACE, cookie({ domain: "github.com" }));
    expect(identity?.hostKey).toBe("github.com");
    expect(hostKeyIsHostOnly(identity!.hostKey)).toBe(true);
  });

  it("honors an explicit hostOnly flag over a dotted domain", () => {
    expect(identityForCookie(SPACE, cookie({ domain: ".github.com", hostOnly: true }))?.hostKey).toBe("github.com");
    // hostOnly: false cannot turn a dotless domain into a domain cookie — the dot is the source of truth.
    expect(identityForCookie(SPACE, cookie({ domain: "github.com", hostOnly: false }))?.hostKey).toBe("github.com");
  });

  it("maps the rest of the tuple: space, path, unpartitioned, source scheme", () => {
    const identity = identityForCookie(SPACE, cookie({ path: "/app", secure: true }));
    expect(identity).toEqual({
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/app",
      partitionKey: "",
      sourceScheme: "secure",
    });
    expect(identityForCookie(SPACE, cookie({ secure: false }))?.sourceScheme).toBe("nonsecure");
  });

  it("returns null for partitioned (CHIPS) cookies", () => {
    expect(identityForCookie(SPACE, cookie({ partitionKey: "https://embedder.example" }))).toBeNull();
    expect(identityForCookie(SPACE, cookie({ partitionKey: "" }))).not.toBeNull();
    expect(identityForCookie(SPACE, cookie())).not.toBeNull();
  });
});

describe("attributesForCookie", () => {
  it("treats a session cookie (no expirationDate) as non-persistent", () => {
    const c = cookie({ session: true });
    delete c.expirationDate;
    const attrs = attributesForCookie(c);
    expect(attrs.expiresMs).toBeNull();
    expect(attrs.persistent).toBe(false);
  });

  it("treats session: true as authoritative even when an expiry is present", () => {
    const attrs = attributesForCookie(cookie({ session: true, expirationDate: 1_900_000_000 }));
    expect(attrs.expiresMs).toBeNull();
    expect(attrs.persistent).toBe(false);
  });

  it("converts expirationDate seconds to expiresMs", () => {
    const attrs = attributesForCookie(cookie({ expirationDate: 1_900_000_000 }));
    expect(attrs.expiresMs).toBe(1_900_000_000_000);
    expect(attrs.persistent).toBe(true);
  });

  it("carries value, secure, httpOnly, sameSite and always priority medium", () => {
    const attrs = attributesForCookie(cookie({ sameSite: "strict" }));
    expect(attrs.value).toBe("v1");
    expect(attrs.secure).toBe(true);
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("strict");
    expect(attrs.priority).toBe("medium");
  });
});

describe("sameSite mapping", () => {
  const values: SameSite[] = ["unspecified", "no_restriction", "lax", "strict"];

  it("round-trips every value in both directions", () => {
    for (const value of values) {
      expect(sameSiteFromChromium(sameSiteToChromium(value))).toBe(value);
      expect(sameSiteToChromium(sameSiteFromChromium(value))).toBe(value);
    }
  });

  it("falls back to unspecified for unknown or missing input", () => {
    expect(sameSiteFromChromium(undefined)).toBe("unspecified");
    expect(sameSiteFromChromium("weird")).toBe("unspecified");
  });
});

describe("portableCookieFromElectron", () => {
  it("fills Electron's optional fields and never sets a partition key", () => {
    const electron: ElectronCookie = { name: "sid", value: "v1", domain: ".github.com", sameSite: "lax" };
    expect(portableCookieFromElectron(electron)).toEqual({
      name: "sid",
      value: "v1",
      domain: ".github.com",
      path: "/",
      secure: false,
      httpOnly: false,
      session: true,
      sameSite: "lax",
      partitionKey: "",
    });
    const persistent = portableCookieFromElectron({ ...electron, expirationDate: 1_900_000_000, secure: true, httpOnly: true, session: false });
    expect(persistent.session).toBe(false);
    expect(persistent.expirationDate).toBe(1_900_000_000);
    expect(persistent.secure).toBe(true);
    expect(persistent.httpOnly).toBe(true);
  });
});

describe("url reconstruction (Electron)", () => {
  it("strips the leading dot and picks https for secure cookies", () => {
    const plain = plainFor({ hostKey: ".github.com" });
    expect(setDetailsForPlain(plain).url).toBe("https://github.com/");
  });

  it("uses http for nonsecure host-only cookies", () => {
    const plain = plainFor(
      { hostKey: "internal.example", sourceScheme: "nonsecure", path: "/x" },
      { secure: false },
    );
    expect(setDetailsForPlain(plain).url).toBe("http://internal.example/x");
  });

  it("removal targets rebuild the url from identity alone", () => {
    const target = removeTargetFor({
      spaceId: SPACE,
      hostKey: ".github.com",
      name: "sid",
      path: "/",
      partitionKey: "",
      sourceScheme: "secure",
    });
    expect(target).toEqual({ url: "https://github.com/", name: "sid" });
  });

  it("cookieUrlFor honors the secure flag even for nonsecure source schemes", () => {
    const identity = {
      spaceId: SPACE,
      hostKey: "example.com",
      name: "a",
      path: "/",
      partitionKey: "",
      sourceScheme: "nonsecure" as const,
    };
    expect(cookieUrlFor(identity, true)).toBe("https://example.com/");
    expect(cookieUrlFor(identity, false)).toBe("http://example.com/");
  });
});

describe("setDetailsForPlain (Electron)", () => {
  it("includes domain for domain cookies and converts expiry to seconds", () => {
    const details = setDetailsForPlain(plainFor({ hostKey: ".github.com" }));
    expect(details.domain).toBe(".github.com");
    expect(details.expirationDate).toBe(1_900_000_000);
    expect(details.secure).toBe(true);
    expect(details.httpOnly).toBe(true);
    expect(details.sameSite).toBe("lax");
  });

  it("omits domain for host-only cookies", () => {
    const details = setDetailsForPlain(plainFor({ hostKey: "github.com" }));
    expect(details.domain).toBeUndefined();
  });

  it("omits expirationDate for session cookies", () => {
    const details = setDetailsForPlain(plainFor({}, { expiresMs: null, persistent: false }));
    expect(details.expirationDate).toBeUndefined();
  });

  it("refuses tombstones", () => {
    const tombstone: CookiePlain = { ...plainFor({}), attributes: null, deleted: true };
    expect(() => setDetailsForPlain(tombstone)).toThrow();
  });
});

describe("playwrightCookieForPlain", () => {
  it("passes the host key as the domain verbatim, never url or expirationDate", () => {
    const domainCookie = playwrightCookieForPlain(plainFor({ hostKey: ".github.com" }));
    expect(domainCookie).toEqual({
      name: "sid",
      value: "v1",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: 1_900_000_000,
      sameSite: "Lax",
    });
    expect("url" in domainCookie).toBe(false);
    expect("expirationDate" in domainCookie).toBe(false);
    expect(playwrightCookieForPlain(plainFor({ hostKey: "github.com" })).domain).toBe("github.com");
  });

  it("uses -1 for session cookies", () => {
    expect(playwrightCookieForPlain(plainFor({}, { expiresMs: null, persistent: false })).expires).toBe(-1);
  });

  it("maps sameSite and omits it for unspecified", () => {
    expect(playwrightCookieForPlain(plainFor({}, { sameSite: "no_restriction" })).sameSite).toBe("None");
    expect(playwrightCookieForPlain(plainFor({}, { sameSite: "lax" })).sameSite).toBe("Lax");
    expect(playwrightCookieForPlain(plainFor({}, { sameSite: "strict" })).sameSite).toBe("Strict");
    const unspecified = playwrightCookieForPlain(plainFor({}, { sameSite: "unspecified" }));
    expect("sameSite" in unspecified).toBe(false);
  });

  it("refuses tombstones", () => {
    const tombstone: CookiePlain = { ...plainFor({}), attributes: null, deleted: true };
    expect(() => playwrightCookieForPlain(tombstone)).toThrow();
  });
});

describe("portableCookieFromCdp", () => {
  function cdp(overrides: Partial<CdpCookie> = {}): CdpCookie {
    return {
      name: "sid",
      value: "v1",
      domain: ".github.com",
      path: "/",
      expires: 1_900_000_000,
      secure: true,
      httpOnly: true,
      session: false,
      sameSite: "Lax",
      ...overrides,
    };
  }

  it("maps a persistent domain cookie", () => {
    expect(portableCookieFromCdp(cdp())).toEqual({
      name: "sid",
      value: "v1",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      session: false,
      expirationDate: 1_900_000_000,
      sameSite: "lax",
      hostOnly: false,
      partitionKey: "",
    });
  });

  it("derives session from expires < 0 or the session flag and drops the expiry", () => {
    const negative = portableCookieFromCdp(cdp({ expires: -1, session: undefined }));
    expect(negative?.session).toBe(true);
    expect(negative?.expirationDate).toBeUndefined();
    const flagged = portableCookieFromCdp(cdp({ session: true }));
    expect(flagged?.session).toBe(true);
  });

  it("marks dotless domains host-only and maps sameSite (undefined ⇒ unspecified)", () => {
    expect(portableCookieFromCdp(cdp({ domain: "github.com" }))?.hostOnly).toBe(true);
    expect(portableCookieFromCdp(cdp({ sameSite: undefined }))?.sameSite).toBe("unspecified");
    expect(portableCookieFromCdp(cdp({ sameSite: "None" }))?.sameSite).toBe("no_restriction");
    expect(portableCookieFromCdp(cdp({ sameSite: "Strict" }))?.sameSite).toBe("strict");
  });

  it("drops partitioned cookies", () => {
    expect(portableCookieFromCdp(cdp({ partitionKey: { topLevelSite: "https://embedder.example", hasCrossSiteAncestor: false } }))).toBeNull();
    expect(portableCookieFromCdp(cdp({ partitionKey: { topLevelSite: "" } }))).not.toBeNull();
  });
});

/**
 * Parity fixtures (§12): the same cookie observed by Electron and by CDP
 * must produce one identity and one attribute set, and applying the synced
 * plaintext on either side must describe the same cookie again.
 */
describe("Electron ⇄ CDP parity", () => {
  interface Fixture {
    label: string;
    electron: ElectronCookie;
    cdp: CdpCookie;
    hostKey: string;
    expiresMs: number | null;
    sameSite: SameSite;
  }

  const fixtures: Fixture[] = [
    {
      label: "host-only",
      electron: { name: "a", value: "1", domain: "github.com", path: "/", secure: true, httpOnly: false, session: false, expirationDate: 1_900_000_000, sameSite: "lax" },
      cdp: { name: "a", value: "1", domain: "github.com", path: "/", expires: 1_900_000_000, secure: true, httpOnly: false, session: false, sameSite: "Lax" },
      hostKey: "github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "lax",
    },
    {
      label: "domain",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: true, session: false, expirationDate: 1_900_000_000, sameSite: "lax" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/", expires: 1_900_000_000, secure: true, httpOnly: true, session: false, sameSite: "Lax" },
      hostKey: ".github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "lax",
    },
    {
      label: "non-root path",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/app/settings", secure: true, httpOnly: false, session: false, expirationDate: 1_900_000_000, sameSite: "strict" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/app/settings", expires: 1_900_000_000, secure: true, httpOnly: false, session: false, sameSite: "Strict" },
      hostKey: ".github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "strict",
    },
    {
      label: "SameSite=None",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: false, session: false, expirationDate: 1_900_000_000, sameSite: "no_restriction" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/", expires: 1_900_000_000, secure: true, httpOnly: false, session: false, sameSite: "None" },
      hostKey: ".github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "no_restriction",
    },
    {
      label: "SameSite=Lax",
      electron: { name: "a", value: "1", domain: "github.com", path: "/", secure: false, httpOnly: false, session: false, expirationDate: 1_900_000_000, sameSite: "lax" },
      cdp: { name: "a", value: "1", domain: "github.com", path: "/", expires: 1_900_000_000, secure: false, httpOnly: false, session: false, sameSite: "Lax" },
      hostKey: "github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "lax",
    },
    {
      label: "SameSite=Strict",
      electron: { name: "a", value: "1", domain: "github.com", path: "/", secure: true, httpOnly: true, session: false, expirationDate: 1_900_000_000, sameSite: "strict" },
      cdp: { name: "a", value: "1", domain: "github.com", path: "/", expires: 1_900_000_000, secure: true, httpOnly: true, session: false, sameSite: "Strict" },
      hostKey: "github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "strict",
    },
    {
      label: "SameSite unspecified",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: false, session: false, expirationDate: 1_900_000_000, sameSite: "unspecified" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/", expires: 1_900_000_000, secure: true, httpOnly: false, session: false },
      hostKey: ".github.com",
      expiresMs: 1_900_000_000_000,
      sameSite: "unspecified",
    },
    {
      label: "session",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: true, session: true, sameSite: "lax" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/", expires: -1, secure: true, httpOnly: true, session: true, sameSite: "Lax" },
      hostKey: ".github.com",
      expiresMs: null,
      sameSite: "lax",
    },
    {
      label: "persistent",
      electron: { name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: true, session: false, expirationDate: 1_950_000_000.5, sameSite: "lax" },
      cdp: { name: "a", value: "1", domain: ".github.com", path: "/", expires: 1_950_000_000.5, secure: true, httpOnly: true, session: false, sameSite: "Lax" },
      hostKey: ".github.com",
      expiresMs: 1_950_000_000_500,
      sameSite: "lax",
    },
  ];

  for (const f of fixtures) {
    it(`${f.label}: both backends observe the same identity and attributes`, () => {
      const fromElectron = portableCookieFromElectron(f.electron);
      const fromCdp = portableCookieFromCdp(f.cdp);
      expect(fromCdp).not.toBeNull();
      const identityE = identityForCookie(SPACE, fromElectron);
      const identityC = identityForCookie(SPACE, fromCdp!);
      expect(identityE).toEqual(identityC);
      expect(identityE?.hostKey).toBe(f.hostKey);
      expect(identityE?.path).toBe(f.cdp.path);
      expect(identityE?.partitionKey).toBe("");
      const attrsE = attributesForCookie(fromElectron);
      const attrsC = attributesForCookie(fromCdp!);
      expect(attrsE).toEqual(attrsC);
      expect(attrsE.expiresMs).toBe(f.expiresMs);
      expect(attrsE.persistent).toBe(f.expiresMs !== null);
      expect(attrsE.sameSite).toBe(f.sameSite);
    });

    it(`${f.label}: applying the synced record on either side describes the same cookie`, () => {
      const portable = portableCookieFromElectron(f.electron);
      const identity = identityForCookie(SPACE, portable)!;
      const plain: CookiePlain = { identity, attributes: attributesForCookie(portable), deleted: false };
      const electronSet = setDetailsForPlain(plain);
      const playwrightSet = playwrightCookieForPlain(plain);
      // Scope: Electron omits domain for host-only; Playwright passes the host key verbatim.
      expect(playwrightSet.domain).toBe(f.hostKey);
      expect(electronSet.domain).toBe(hostKeyIsHostOnly(f.hostKey) ? undefined : f.hostKey);
      expect(playwrightSet.path).toBe(electronSet.path);
      expect(playwrightSet.secure).toBe(electronSet.secure);
      expect(playwrightSet.httpOnly).toBe(electronSet.httpOnly);
      // Expiry: Electron omits, Playwright uses -1, for session cookies.
      expect(electronSet.expirationDate).toBe(f.expiresMs === null ? undefined : f.expiresMs / 1000);
      expect(playwrightSet.expires).toBe(f.expiresMs === null ? -1 : f.expiresMs / 1000);
      // SameSite: Electron keeps Chromium's names; Playwright omits `unspecified`.
      expect(electronSet.sameSite).toBe(f.sameSite);
      expect(playwrightSet.sameSite).toBe(
        f.sameSite === "unspecified" ? undefined : { no_restriction: "None", lax: "Lax", strict: "Strict" }[f.sameSite],
      );
      // Round trip: a CDP read-back of the applied Playwright cookie observes the same identity again.
      const readBack: CdpCookie = {
        name: playwrightSet.name,
        value: playwrightSet.value,
        domain: playwrightSet.domain,
        path: playwrightSet.path,
        expires: playwrightSet.expires,
        secure: playwrightSet.secure,
        httpOnly: playwrightSet.httpOnly,
        session: playwrightSet.expires < 0,
        ...(playwrightSet.sameSite === undefined ? {} : { sameSite: playwrightSet.sameSite }),
      };
      const observed = portableCookieFromCdp(readBack)!;
      expect(identityForCookie(SPACE, observed)).toEqual(identity);
      expect(attributesForCookie(observed)).toEqual(plain.attributes);
    });
  }

  it("partitioned: dropped on the CDP side and never produces an identity", () => {
    const partitioned: CdpCookie = {
      name: "a",
      value: "1",
      domain: ".embedded.example",
      path: "/",
      expires: 1_900_000_000,
      secure: true,
      httpOnly: false,
      session: false,
      sameSite: "None",
      partitionKey: { topLevelSite: "https://embedder.example", hasCrossSiteAncestor: true },
    };
    expect(portableCookieFromCdp(partitioned)).toBeNull();
    const asPortable = cookie({ domain: ".embedded.example", partitionKey: "https://embedder.example" });
    expect(identityForCookie(SPACE, asPortable)).toBeNull();
  });
});
