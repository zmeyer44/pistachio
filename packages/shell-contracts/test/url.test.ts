import { describe, expect, it } from "vitest";
import { DEFAULT_HOME_URL, externalAppScheme, isAllowedNavigation, normalizeNavigation, pasteAndGoUrl, searchUrl, viewSourceUrl } from "../src/url.js";

describe("browser navigation", () => {
  it("keeps supported URLs and upgrades host-shaped input", () => {
    expect(normalizeNavigation("pistachio://demo/invoices")).toBe(
      "pistachio://demo/invoices",
    );
    expect(normalizeNavigation("example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("sends local and private hosts over plain http, which is all a dev server speaks", () => {
    expect(normalizeNavigation("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeNavigation("localhost")).toBe("http://localhost");
    expect(normalizeNavigation("app.localhost:5173/x")).toBe("http://app.localhost:5173/x");
    expect(normalizeNavigation("127.0.0.1:8080/api")).toBe("http://127.0.0.1:8080/api");
    expect(normalizeNavigation("192.168.1.20")).toBe("http://192.168.1.20");
    expect(normalizeNavigation("10.0.0.1:8080")).toBe("http://10.0.0.1:8080");
    expect(normalizeNavigation("172.16.0.1")).toBe("http://172.16.0.1");
    // ...but only when the input has no scheme, and only for local hosts.
    expect(normalizeNavigation("https://localhost:3000")).toBe("https://localhost:3000");
    expect(normalizeNavigation("localhost.example.com")).toBe("https://localhost.example.com");
    expect(normalizeNavigation("8.8.8.8")).toBe("https://8.8.8.8");
    expect(normalizeNavigation("172.32.0.1")).toBe("https://172.32.0.1");
  });

  it("lands an empty address on the default home page, which is Pistachio's own, not the demo", () => {
    expect(DEFAULT_HOME_URL).toBe("pistachio://home/");
    expect(normalizeNavigation("   ")).toBe(DEFAULT_HOME_URL);
  });

  it("turns prose into a search and rejects privileged schemes", () => {
    expect(normalizeNavigation("invoice policy")).toBe(
      "https://www.google.com/search?q=invoice%20policy",
    );
    // A single word is what the bar OFFERS to search for — it must never be
    // read as a host, or ↵ lands on https://hackernews and errors out.
    expect(normalizeNavigation("hackernews")).toBe(searchUrl("hackernews"));
    expect(normalizeNavigation("invoices")).toBe(searchUrl("invoices"));
    expect(normalizeNavigation("v1.2")).toBe(searchUrl("v1.2"));
    // ...unless the input itself says host: a port or a path follows it.
    expect(normalizeNavigation("intranet:8080")).toBe("https://intranet:8080");
    expect(normalizeNavigation("build-box/status")).toBe("https://build-box/status");
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)")).toBe(false);
  });

  it("opens a web page's source as its own tab, but wraps nothing privileged", () => {
    expect(viewSourceUrl("https://example.com/a")).toBe("view-source:https://example.com/a");
    expect(viewSourceUrl("pistachio://demo/invoices")).toBeNull();
    expect(isAllowedNavigation("view-source:https://example.com/a")).toBe(true);
    expect(normalizeNavigation("view-source:http://localhost:3000")).toBe("view-source:http://localhost:3000");
    expect(isAllowedNavigation("view-source:file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation("view-source:javascript:alert(1)")).toBe(false);
    expect(isAllowedNavigation("view-source:view-source:https://example.com")).toBe(false);
    expect(isAllowedNavigation("view-source:")).toBe(false);
  });

  it("builds the same search the address bar runs", () => {
    expect(searchUrl("invoice policy")).toBe("https://www.google.com/search?q=invoice%20policy");
    expect(normalizeNavigation("invoice policy")).toBe(searchUrl("invoice policy"));
  });
});

describe("paste and go", () => {
  it("offers a copied address, or a bare host over the scheme it is served on", () => {
    expect(pasteAndGoUrl("  https://example.com/path?x=1 \n")).toBe("https://example.com/path?x=1");
    expect(pasteAndGoUrl("pistachio://demo/invoices")).toBe("pistachio://demo/invoices");
    expect(pasteAndGoUrl("example.com/path")).toBe("https://example.com/path");
    expect(pasteAndGoUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(pasteAndGoUrl("10.0.0.1:8080")).toBe("http://10.0.0.1:8080");
  });

  it("never invents an address from prose, a word, several lines, or a privileged scheme", () => {
    expect(pasteAndGoUrl("")).toBeNull();
    expect(pasteAndGoUrl("invoice policy")).toBeNull();
    expect(pasteAndGoUrl("invoices")).toBeNull();
    expect(pasteAndGoUrl("v1.2")).toBeNull();
    expect(pasteAndGoUrl("https://a.example\nhttps://b.example")).toBeNull();
    expect(pasteAndGoUrl("file:///etc/passwd")).toBeNull();
    expect(pasteAndGoUrl("javascript:alert(1)")).toBeNull();
    expect(pasteAndGoUrl("mailto:someone@example.com")).toBeNull();
  });

  it("recognizes a link meant for another app, and nothing the browser owns", () => {
    expect(externalAppScheme("zoommtg://zoom.us/join?confno=123&pwd=abc")).toBe("zoommtg");
    expect(externalAppScheme("mailto:someone@example.com")).toBe("mailto");
    expect(externalAppScheme("SLACK://open?team=T1")).toBe("slack");
    expect(externalAppScheme("msteams:/l/meetup-join/19")).toBe("msteams");
    // Still never a place a tab navigates to.
    expect(isAllowedNavigation("zoommtg://zoom.us/join")).toBe(false);

    for (const own of [
      "https://zoom.us/j/123",
      "http://localhost:3000",
      "pistachio://home",
      "pistachio-app://shell/index.html",
      "file:///Applications/zoom.us.app",
      "javascript:alert(1)",
      "data:text/html,<p>hi",
      "blob:https://example.com/0b7e",
      "about:blank",
      "view-source:https://example.com",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
    ])
      expect(externalAppScheme(own), own).toBeNull();
  });

  it("never offers a handler with a history of running what a page hands it", () => {
    expect(externalAppScheme("ms-msdt:/id PCWDiagnostic /skip force")).toBeNull();
    expect(externalAppScheme("search-ms:query=invoice&crumb=location:%5C%5Cevil.test")).toBeNull();
    expect(externalAppScheme("ms-officecmd:%7B%22id%22:3%7D")).toBeNull();
  });

  it("drops malformed and absurdly long app links", () => {
    expect(externalAppScheme("")).toBeNull();
    expect(externalAppScheme("not a url")).toBeNull();
    expect(externalAppScheme("/relative/path")).toBeNull();
    expect(externalAppScheme(`zoommtg://zoom.us/join?x=${"a".repeat(9000)}`)).toBeNull();
  });
});
