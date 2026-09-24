import { describe, expect, it } from "vitest";
import {
  navigationErrorHtml,
  navigationErrorScript,
  navigationErrorTitle,
} from "../src/main/navigation-error-page";

const refused = {
  url: "http://127.0.0.1:59998/",
  code: -102,
  description: "ERR_CONNECTION_REFUSED",
  canGoBack: true,
};

describe("navigation error page", () => {
  it("names the host in the title and explains the failure plainly", () => {
    expect(navigationErrorTitle(refused)).toBe("Can't reach 127.0.0.1:59998");
    const html = navigationErrorHtml(refused);
    expect(html).toContain("127.0.0.1:59998 refused to connect");
    expect(html).toContain("Nothing is answering at this address");
    expect(html).not.toContain("pistachio:tab-navigate");
  });

  it("keeps the Chromium code behind a details disclosure", () => {
    const html = navigationErrorHtml(refused);
    expect(html).toContain("<summary>Technical details</summary>");
    expect(html).toContain("ERR_CONNECTION_REFUSED (-102)");
  });

  it("offers Back only when there is history to return to", () => {
    expect(navigationErrorHtml(refused)).toContain('id="back"');
    expect(navigationErrorHtml({ ...refused, canGoBack: false })).not.toContain('id="back"');
    expect(navigationErrorHtml(refused)).toContain('id="retry"');
  });

  it("reads the common net errors", () => {
    const titleFor = (code: number): string =>
      /<h1>([^<]+)<\/h1>/u.exec(navigationErrorHtml({ ...refused, code, url: "https://example.test/" }))?.[1] ?? "";
    expect(titleFor(-105)).toBe("example.test could not be found");
    expect(titleFor(-106)).toBe("You are offline");
    expect(titleFor(-312)).toBe("This port is blocked");
    expect(titleFor(-201)).toBe("The connection to example.test is not private");
    expect(titleFor(-999)).toBe("example.test can't be reached");
  });

  it("escapes the failed address rather than rendering it", () => {
    const html = navigationErrorHtml({ ...refused, url: "http://evil.test/<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("produces a script that writes the document and wires the buttons", () => {
    const script = navigationErrorScript(refused);
    expect(script).toContain("document.documentElement.innerHTML = ");
    expect(script).toContain("location.reload()");
    expect(script).toContain("history.back()");
    // The document is embedded as a JSON string, so it survives as one line.
    expect(() => JSON.parse(/innerHTML = (".*");/u.exec(script)?.[1] ?? "null")).not.toThrow();
  });
});
