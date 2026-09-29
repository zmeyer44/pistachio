/** Which picture stands for a tab in the desk's dock (src/lib/desk/tab-icon.ts). */

import { describe, expect, it } from "vitest";
import { tabIcon } from "../src/lib/desk/tab-icon";

const APP = "https://example.com/touch.png";
const FAVICON = "https://example.com/favicon.ico";

describe("a tab's icon in the dock", () => {
  it("is its app icon, else its favicon, else its initial", () => {
    expect(tabIcon(APP, FAVICON, new Set())).toEqual({ kind: "app", src: APP });
    expect(tabIcon(undefined, FAVICON, new Set())).toEqual({ kind: "favicon", src: FAVICON });
    expect(tabIcon(null, null, new Set())).toEqual({ kind: "letter" });
  });

  it("passes over what failed to load, and with both failed stays on the initial", () => {
    expect(tabIcon(APP, FAVICON, new Set([APP]))).toEqual({ kind: "favicon", src: FAVICON });
    // The favicon failing after the app icon must not bring the app icon back (it would fail again, and so on).
    expect(tabIcon(APP, FAVICON, new Set([APP, FAVICON]))).toEqual({ kind: "letter" });
    expect(tabIcon(APP, FAVICON, new Set([FAVICON]))).toEqual({ kind: "app", src: APP });
  });
});
