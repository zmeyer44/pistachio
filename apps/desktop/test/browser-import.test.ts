import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bookmarksToEntries,
  chromiumSameSite,
  chromiumTimeToUnixSeconds,
  cookieDetails,
  cookieOrigins,
  countBookmarks,
  firefoxSameSite,
  isProfileId,
  parseChromiumBookmarks,
  parseLocalState,
  parseProfilesIni,
  parseSafariBookmarks,
  registrableHost,
  sanitizeBrowserImportRequest,
  sanitizeBrowserImportRequests,
  MAX_IMPORT_PROFILES,
  type ImportedCookie,
} from "@pistachio/shell-contracts/browser-import";
import {
  decryptChromiumCookieValue,
  deriveChromiumKey,
  firefoxRowsToTree,
} from "../src/main/browser-import";

describe("parseLocalState", () => {
  it("lists profiles with their signed-in account, the last used first", () => {
    const profiles = parseLocalState({
      profile: {
        last_used: "Profile 3",
        info_cache: {
          Default: { name: "Person 1", user_name: "", gaia_name: "" },
          "Profile 3": {
            name: "Work",
            user_name: "ada@example.com",
            gaia_name: "Ada Lovelace",
          },
          "../etc": { name: "nope" },
        },
      },
    });
    expect(profiles).toEqual([
      {
        id: "Profile 3",
        name: "Work",
        account: { email: "ada@example.com", displayName: "Ada Lovelace" },
        lastUsed: true,
      },
      { id: "Default", name: "Person 1", account: null, lastUsed: false },
    ]);
  });

  it("is empty for anything that is not a Local State", () => {
    expect(parseLocalState(null)).toEqual([]);
    expect(parseLocalState({ profile: {} })).toEqual([]);
  });
});

describe("parseProfilesIni", () => {
  const ini = `[Profile1]
Name=default
IsRelative=1
Path=Profiles/e5mzv8ah.default
Default=1

[Profile0]
Name=default-release
IsRelative=1
Path=Profiles/cjfsy5wb.default-release

[General]
StartWithLastProfile=1

[Install2656FF1E876E9973]
Default=Profiles/cjfsy5wb.default-release
Locked=1
`;
  it("prefers the install's default over the legacy Default=1 flag", () => {
    const profiles = parseProfilesIni(ini);
    expect(profiles.map((profile) => [profile.id, profile.isDefault])).toEqual([
      ["cjfsy5wb.default-release", true],
      ["e5mzv8ah.default", false],
    ]);
    expect(profiles[0]?.path).toBe("Profiles/cjfsy5wb.default-release");
    expect(profiles[0]?.isRelative).toBe(true);
  });
});

describe("bookmarks", () => {
  const chromium = {
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        children: [
          { type: "url", name: "Linear", url: "https://linear.app/" },
          {
            type: "folder",
            name: "Recipes",
            children: [
              {
                type: "url",
                name: "Slump",
                url: "https://cooking.example/slump",
              },
              {
                type: "folder",
                name: "Weeknight",
                children: [
                  {
                    type: "url",
                    name: "Dal",
                    url: "https://cooking.example/dal",
                  },
                ],
              },
            ],
          },
          { type: "url", name: "Bad", url: "javascript:alert(1)" },
        ],
      },
      other: {
        type: "folder",
        name: "Other bookmarks",
        children: [{ type: "url", name: "Docs", url: "https://docs.example/" }],
      },
      synced: { type: "folder", name: "Mobile bookmarks", children: [] },
    },
  };

  it("reads Chromium's file: the bar's links at the top, the other roots as folders, bad addresses dropped", () => {
    const tree = parseChromiumBookmarks(chromium);
    expect(
      tree.map((node) => (node.kind === "link" ? node.url : node.name)),
    ).toEqual(["https://linear.app/", "Recipes", "Other bookmarks"]);
    expect(countBookmarks(tree)).toBe(4);
  });

  it("flattens the tree into one-level shelf folders named by path", () => {
    let n = 0;
    const built = bookmarksToEntries(
      parseChromiumBookmarks(chromium),
      "Chrome bookmarks",
      () => `id-${String(++n)}`,
    );
    const folders = built.entries
      .filter((entry) => entry.kind === "folder")
      .map((entry) => entry.name);
    expect(folders).toEqual([
      "Chrome bookmarks",
      "Chrome bookmarks · Recipes",
      "Chrome bookmarks · Recipes · Weeknight",
      "Chrome bookmarks · Other bookmarks",
    ]);
    expect(built.pins).toBe(4);
    expect(built.folders).toBe(4);
    const dal = built.entries.find(
      (entry) =>
        entry.kind === "pin" && entry.url === "https://cooking.example/dal",
    );
    expect(dal?.kind === "pin" && dal.folderId).toBe("id-5");
    // Every pin names a folder that exists.
    const folderIds = new Set(
      built.entries
        .filter((entry) => entry.kind === "folder")
        .map((entry) => entry.id),
    );
    for (const entry of built.entries)
      if (entry.kind === "pin")
        expect(folderIds.has(entry.folderId ?? "")).toBe(true);
  });

  it("does not pin the same address twice", () => {
    const tree = parseChromiumBookmarks({
      roots: {
        bookmark_bar: {
          type: "folder",
          children: [
            { type: "url", name: "A", url: "https://a.example/" },
            {
              type: "folder",
              name: "Again",
              children: [{ type: "url", name: "A", url: "https://a.example/" }],
            },
          ],
        },
      },
    });
    const built = bookmarksToEntries(tree, "X", () =>
      Math.random().toString(36),
    );
    expect(built.pins).toBe(1);
    expect(built.folders).toBe(1);
  });

  it("reads Safari's plist as JSON, unwrapping the bar and menu", () => {
    const tree = parseSafariBookmarks({
      WebBookmarkType: "WebBookmarkTypeList",
      Title: "",
      Children: [
        {
          WebBookmarkType: "WebBookmarkTypeList",
          Title: "BookmarksBar",
          Children: [
            {
              WebBookmarkType: "WebBookmarkTypeLeaf",
              URLString: "https://apple.com/",
              URIDictionary: { title: "Apple" },
            },
          ],
        },
        {
          WebBookmarkType: "WebBookmarkTypeList",
          Title: "com.apple.ReadingList",
          Children: [],
        },
        {
          WebBookmarkType: "WebBookmarkTypeLeaf",
          URLString: "file:///etc/passwd",
          URIDictionary: { title: "nope" },
        },
      ],
    });
    expect(tree).toEqual([
      { kind: "link", title: "Apple", url: "https://apple.com/" },
    ]);
  });

  it("builds Firefox's tree from its rows, toolbar at the top", () => {
    const tree = firefoxRowsToTree([
      {
        id: 1n,
        parent: 0n,
        type: 2n,
        title: "",
        url: null,
        guid: "root________",
      },
      {
        id: 3n,
        parent: 1n,
        type: 2n,
        title: "toolbar",
        url: null,
        guid: "toolbar_____",
      },
      {
        id: 2n,
        parent: 1n,
        type: 2n,
        title: "menu",
        url: null,
        guid: "menu________",
      },
      {
        id: 10n,
        parent: 3n,
        type: 1n,
        title: "Mozilla",
        url: "https://mozilla.org/",
        guid: "a",
      },
      { id: 11n, parent: 3n, type: 2n, title: "Work", url: null, guid: "b" },
      {
        id: 12n,
        parent: 11n,
        type: 1n,
        title: "Jira",
        url: "https://jira.example/",
        guid: "c",
      },
      {
        id: 13n,
        parent: 2n,
        type: 1n,
        title: "Query",
        url: "place:sort=8",
        guid: "d",
      },
      {
        id: 14n,
        parent: 2n,
        type: 1n,
        title: "News",
        url: "https://news.example/",
        guid: "e",
      },
    ]);
    expect(tree).toEqual([
      { kind: "link", title: "Mozilla", url: "https://mozilla.org/" },
      {
        kind: "folder",
        name: "Work",
        children: [
          { kind: "link", title: "Jira", url: "https://jira.example/" },
        ],
      },
      {
        kind: "folder",
        name: "Bookmarks Menu",
        children: [
          { kind: "link", title: "News", url: "https://news.example/" },
        ],
      },
    ]);
  });
});

describe("cookies", () => {
  it("converts Chromium's 1601-epoch microseconds", () => {
    expect(chromiumTimeToUnixSeconds(0n)).toBeNull();
    // 2026-01-01T00:00:00Z in Chromium time.
    expect(chromiumTimeToUnixSeconds(13411699200000000n)).toBe(1767225600);
  });

  it("maps SameSite for both engines", () => {
    expect(chromiumSameSite(-1n)).toBe("unspecified");
    expect(chromiumSameSite(0)).toBe("no_restriction");
    expect(chromiumSameSite(1n)).toBe("lax");
    expect(chromiumSameSite(2n)).toBe("strict");
    expect(firefoxSameSite(0n)).toBe("no_restriction");
    expect(firefoxSameSite(2n)).toBe("strict");
  });

  const cookie: ImportedCookie = {
    host: ".github.com",
    name: "user_session",
    value: "abc",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expires: 2_000_000_000,
  };

  it("becomes what Electron's session takes, with the domain for a domain cookie", () => {
    expect(cookieDetails(cookie, 1_000_000_000)).toEqual({
      url: "https://github.com/",
      name: "user_session",
      value: "abc",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 2_000_000_000,
    });
    const hostOnly = cookieDetails({
      ...cookie,
      host: "api.github.com",
      expires: null,
      secure: false,
      sameSite: "no_restriction",
    });
    expect(hostOnly?.domain).toBeUndefined();
    expect(hostOnly?.url).toBe("http://api.github.com/");
    expect(hostOnly?.expirationDate).toBeUndefined();
    // SameSite=None needs Secure; Chromium would refuse it, so it is relaxed.
    expect(hostOnly?.sameSite).toBe("unspecified");
  });

  it("refuses an expired or unnamed cookie", () => {
    expect(cookieDetails(cookie, 3_000_000_000)).toBeNull();
    expect(cookieDetails({ ...cookie, name: "" })).toBeNull();
  });

  it("summarizes the sites signed in to, most cookies first", () => {
    const many = (host: string, n: number): ImportedCookie[] =>
      Array.from({ length: n }, (_, i) => ({
        ...cookie,
        host,
        name: `c${String(i)}`,
      }));
    expect(
      cookieOrigins([
        ...many(".github.com", 2),
        ...many("mail.google.com", 3),
        ...many(".bbc.co.uk", 1),
      ]),
    ).toEqual(["google.com", "github.com", "bbc.co.uk"]);
    expect(registrableHost("a.b.example.com")).toBe("example.com");
  });

  it("decrypts a v10 value with the derived key and drops the domain hash on schema 24", () => {
    const key = deriveChromiumKey("correct horse battery staple");
    expect(key).toHaveLength(16);
    const encrypt = (plain: Buffer): Uint8Array => {
      const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      return new Uint8Array(
        Buffer.concat([
          Buffer.from("v10"),
          cipher.update(plain),
          cipher.final(),
        ]),
      );
    };
    expect(
      decryptChromiumCookieValue(
        encrypt(Buffer.from("session-token")),
        key,
        20,
      ),
    ).toBe("session-token");
    const hashed = Buffer.concat([
      Buffer.alloc(32, 7),
      Buffer.from("session-token"),
    ]);
    expect(decryptChromiumCookieValue(encrypt(hashed), key, 24)).toBe(
      "session-token",
    );
    expect(
      decryptChromiumCookieValue(
        new Uint8Array(Buffer.from("v11xxxx")),
        key,
        24,
      ),
    ).toBeNull();
    expect(decryptChromiumCookieValue(new Uint8Array(), key, 24)).toBe("");
    // The wrong key does not throw; it just cannot open the value.
    expect(
      decryptChromiumCookieValue(
        encrypt(Buffer.from("x")),
        deriveChromiumKey("other"),
        20,
      ),
    ).not.toBe("x");
  });
});

describe("sanitizeBrowserImportRequest", () => {
  it("accepts a known browser and a plain profile directory name", () => {
    expect(
      sanitizeBrowserImportRequest({
        browser: "chrome",
        profileId: "Profile 3",
        sessions: true,
        bookmarks: "yes",
      }),
    ).toEqual({
      browser: "chrome",
      profileId: "Profile 3",
      sessions: true,
      bookmarks: false,
    });
  });

  it("refuses anything that could climb out of the profile root", () => {
    expect(isProfileId("../Library")).toBe(false);
    expect(isProfileId("Profile/3")).toBe(false);
    expect(isProfileId("..")).toBe(false);
    expect(
      sanitizeBrowserImportRequest({ browser: "chrome", profileId: "../x" }),
    ).toBeNull();
    expect(
      sanitizeBrowserImportRequest({
        browser: "netscape",
        profileId: "Default",
      }),
    ).toBeNull();
  });
});

describe("sanitizeBrowserImportRequests", () => {
  it("keeps every usable profile once, across browsers, in the order asked", () => {
    expect(
      sanitizeBrowserImportRequests([
        {
          browser: "chrome",
          profileId: "Default",
          sessions: true,
          bookmarks: true,
        },
        {
          browser: "firefox",
          profileId: "abc.default-release",
          sessions: true,
          bookmarks: true,
        },
        {
          browser: "chrome",
          profileId: "Default",
          sessions: true,
          bookmarks: true,
        },
        {
          browser: "chrome",
          profileId: "../x",
          sessions: true,
          bookmarks: true,
        },
      ])?.map((request) => `${request.browser}/${request.profileId}`),
    ).toEqual(["chrome/Default", "firefox/abc.default-release"]);
  });

  it("is null with nothing usable, and stops at the cap", () => {
    expect(sanitizeBrowserImportRequests([])).toBeNull();
    expect(sanitizeBrowserImportRequests("Default")).toBeNull();
    expect(
      sanitizeBrowserImportRequests([
        { browser: "netscape", profileId: "Default" },
      ]),
    ).toBeNull();
    const many = Array.from({ length: MAX_IMPORT_PROFILES + 5 }, (_, at) => ({
      browser: "chrome",
      profileId: `Profile ${String(at)}`,
    }));
    expect(sanitizeBrowserImportRequests(many)).toHaveLength(
      MAX_IMPORT_PROFILES,
    );
  });
});
