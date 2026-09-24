import { describe, expect, it } from "vitest";
import {
  collectAssetIds,
  collectOpAssetIds,
  isBrokerable,
  parseSrcset,
  rewriteAttributes,
  rewriteCss,
  rewriteNode,
  rewriteOp,
  serializeSrcset,
  type MirrorNode,
} from "../src/index.js";

const BASE = "https://site.example/a/page.html";

function resolver(): { resolve: (url: string) => string; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    resolve: (url) => {
      seen.push(url);
      return `pa-asset:${seen.length}`;
    },
  };
}

describe("rewriteCss", () => {
  it("rewrites relative, quoted and bare url() forms against the sheet's base", () => {
    const { resolve, seen } = resolver();
    const css = `.a{background:url(img/a.png)} .b{background:url("../b.png")} @font-face{src:url('/f.woff2') format("woff2")}`;
    const out = rewriteCss(css, BASE, resolve);
    expect(seen).toEqual(["https://site.example/a/img/a.png", "https://site.example/b.png", "https://site.example/f.woff2"]);
    expect(out).toBe(
      `.a{background:url("pa-asset:1")} .b{background:url("pa-asset:2")} @font-face{src:url("pa-asset:3") format("woff2")}`,
    );
  });

  it("leaves data:, fragments and unparsable URLs alone", () => {
    const { resolve, seen } = resolver();
    const css = `.a{background:url(data:image/png;base64,AAAA)} .b{fill:url(#grad)} .c{background:url()}`;
    expect(rewriteCss(css, BASE, resolve)).toBe(css);
    expect(seen).toEqual([]);
  });

  it("rewrites string-form @import to a url() token", () => {
    const { resolve } = resolver();
    expect(rewriteCss(`@import "theme.css"; body{}`, BASE, resolve)).toBe(`@import url("pa-asset:1"); body{}`);
  });

  it("keeps the original when the resolver declines", () => {
    const css = `.a{background:url(https://cdn.example/x.png)}`;
    expect(rewriteCss(css, BASE, () => null)).toBe(css);
  });
});

describe("srcset", () => {
  it("parses candidates with and without descriptors", () => {
    expect(parseSrcset("a.png 1x, b.png 2x,c.png")).toEqual([
      { url: "a.png", descriptor: "1x" },
      { url: "b.png", descriptor: "2x" },
      { url: "c.png", descriptor: "" },
    ]);
    expect(serializeSrcset(parseSrcset("a.png 480w, b.png 800w"))).toBe("a.png 480w, b.png 800w");
  });
});

describe("rewriteAttributes", () => {
  it("rewrites the attributes that name bytes and leaves links alone", () => {
    const { resolve, seen } = resolver();
    const out = rewriteAttributes("img", { src: "x.png", srcset: "x.png 1x, y.png 2x", alt: "hi" }, BASE, resolve);
    expect(out).toEqual({ src: "pa-asset:1", srcset: "pa-asset:2 1x, pa-asset:3 2x", alt: "hi" });
    expect(seen).toEqual(["https://site.example/a/x.png", "https://site.example/a/x.png", "https://site.example/a/y.png"]);
    const anchor = rewriteAttributes("a", { href: "next.html" }, BASE, resolve);
    expect(anchor).toEqual({ href: "next.html" });
  });

  it("rewrites url() inside an inline style", () => {
    const { resolve } = resolver();
    const out = rewriteAttributes("div", { style: "background-image: url(bg.jpg)" }, BASE, resolve);
    expect(out["style"]).toBe(`background-image: url("pa-asset:1")`);
  });

  it("does not broker javascript: or about: URLs", () => {
    expect(isBrokerable("javascript:alert(1)")).toBe(false);
    expect(isBrokerable("about:blank")).toBe(false);
    expect(isBrokerable("blob:https://site.example/uuid")).toBe(true);
    expect(isBrokerable("https://site.example/x")).toBe(true);
  });
});

describe("trees and ops", () => {
  const tree: MirrorNode = {
    t: "doc",
    id: 1,
    adopted: [".x{background:url(a.png)}"],
    c: [
      {
        t: "e",
        id: 2,
        tag: "html",
        c: [
          { t: "e", id: 3, tag: "link", a: { rel: "stylesheet", href: "css/site.css" }, css: ".y{background:url(y.png)}" },
          { t: "e", id: 4, tag: "img", a: { src: "i.png" } },
          { t: "e", id: 5, tag: "x-host", sh: [{ t: "e", id: 6, tag: "img", a: { src: "s.png" } }], shs: [".z{background:url(z.png)}"] },
        ],
      },
    ],
  };

  it("rewrites every reference in a tree, resolving a linked sheet's urls against the sheet", () => {
    const { resolve, seen } = resolver();
    const out = rewriteNode(tree, BASE, resolve);
    expect(seen).toEqual([
      "https://site.example/a/a.png",
      "https://site.example/a/css/site.css",
      "https://site.example/a/css/y.png",
      "https://site.example/a/i.png",
      "https://site.example/a/s.png",
      "https://site.example/a/z.png",
    ]);
    expect([...collectAssetIds(out)].sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("rewrites the ops that carry references and knows the tag of an attribute's element", () => {
    const { resolve } = resolver();
    const tagOf = (id: number): string | null => (id === 4 ? "img" : id === 9 ? "a" : null);
    expect(rewriteOp({ o: "attr", id: 4, k: "src", v: "j.png" }, BASE, resolve, tagOf)).toEqual({ o: "attr", id: 4, k: "src", v: "pa-asset:1" });
    expect(rewriteOp({ o: "attr", id: 9, k: "href", v: "j.png" }, BASE, resolve, tagOf)).toEqual({ o: "attr", id: 9, k: "href", v: "j.png" });
    const css = rewriteOp({ o: "css", id: 3, s: ".q{background:url(q.png)}" }, BASE, resolve, tagOf);
    expect(collectOpAssetIds(css)).toEqual(new Set(["2"]));
    const add = rewriteOp({ o: "add", p: 2, b: null, n: { t: "e", id: 7, tag: "img", a: { src: "k.png" } } }, BASE, resolve, tagOf);
    expect(collectOpAssetIds(add)).toEqual(new Set(["3"]));
  });
});
