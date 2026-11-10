#!/usr/bin/env node
/**
 * The logos of the curated Chrome Web Store extensions ("Works in Pistachio", src/main/extensions/chrome/curated.ts):
 * each is taken from the extension's own package — the largest of its manifest's `icons`, the picture the store's
 * listing shows — and written into the shell's static files, src/renderer/public/extension-icons/<id>.png, where the
 * extensions page draws it before anything is installed. Run it again when the list changes or a logo looks dated:
 *
 *   node scripts/fetch-curated-icons.mjs            every id curated.ts names
 *   node scripts/fetch-curated-icons.mjs <id> […]   these alone
 *
 * It needs the network (the store's update endpoint hands out the package), `unzip` and macOS's `sips` (a logo
 * larger than 128px is brought down to it; one that is not a PNG becomes one). An id the store no longer serves,
 * or whose package names no icon, is skipped and listed at the end: its entry keeps `iconUrl: null` and the page
 * draws its monogram.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const curatedFile = resolve(here, "../src/main/extensions/chrome/curated.ts");
const outDir = resolve(here, "../src/renderer/public/extension-icons");

const ID = /^[a-p]{32}$/;
const asked = process.argv.slice(2);
const ids = asked.length > 0 ? asked : [...readFileSync(curatedFile, "utf8").matchAll(/cwsId:\s*"([a-p]{32})"/g)].map((m) => m[1]);
for (const id of ids) if (!ID.test(id)) throw new Error(`not a Chrome extension id: ${id}`);

/** The largest side a logo is kept at: the shell draws one at 26px at most, 52 device pixels on a Retina display. */
const MAX_SIDE = 128;
/**
 * The store's update endpoint answers a CRX3 package for any id it serves (a redirect to the file), or 204 for one
 * it does not — which includes one whose current version asks for a newer Chrome than `prodversion` says, so that
 * is the Chromium Pistachio runs on, not an old one.
 */
function packageUrl(id) {
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0.0.0&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&uc`)}`;
}

/** `sips`' word on a PNG's size. */
function sideOf(file) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]).toString("utf8");
  return Math.max(...[...out.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])));
}

/** The zip inside a CRX3: "Cr24", version 3, the header's length, the header, then the archive. */
function zipOf(crx) {
  if (crx.length < 16 || crx.toString("latin1", 0, 4) !== "Cr24") throw new Error("not a CRX package");
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version}, not 3`);
  const headerLength = crx.readUInt32LE(8);
  return crx.subarray(12 + headerLength);
}

/** The largest icon an image set names (keys are sizes), as a path inside the package. */
function largest(icons) {
  if (typeof icons === "string") return icons;
  if (icons === null || typeof icons !== "object") return null;
  const sizes = Object.keys(icons)
    .map((key) => Number.parseInt(key, 10))
    .filter((n) => Number.isFinite(n) && typeof icons[String(n)] === "string")
    .sort((a, b) => b - a);
  return sizes.length === 0 ? null : { size: sizes[0], path: icons[String(sizes[0])].replace(/^\/+/, "") };
}

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "curated-icons-"));
const skipped = [];
const rows = [];
try {
  for (const id of ids) {
    const zipPath = join(work, `${id}.zip`);
    try {
      const response = await fetch(packageUrl(id), { redirect: "follow" });
      if (response.status === 204) throw new Error("the store no longer serves it");
      if (!response.ok) throw new Error(`the store answered ${response.status}`);
      writeFileSync(zipPath, zipOf(Buffer.from(await response.arrayBuffer())));
      const manifest = JSON.parse(execFileSync("unzip", ["-p", zipPath, "manifest.json"], { maxBuffer: 16 * 1024 * 1024 }).toString("utf8").replace(/^\uFEFF/, ""));
      const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
      const chosen = largest(manifest.icons) ?? largest(action?.default_icon);
      if (chosen === null) throw new Error("its manifest names no icon");
      const picked = typeof chosen === "string" ? { size: 0, path: chosen.replace(/^\/+/, "") } : chosen;
      let bytes = execFileSync("unzip", ["-p", zipPath, picked.path], { maxBuffer: 16 * 1024 * 1024 });
      const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
      const source = join(work, `${id}${extname(picked.path) || ".img"}`);
      writeFileSync(source, bytes);
      const side = sideOf(source);
      let converted = "";
      if (!isPng || side > MAX_SIDE) {
        // (Chrome takes a JPEG, a GIF or a WebP for an icon too; the shell gets a PNG, no larger than it draws.)
        const png = join(work, `${id}.png`);
        execFileSync("sips", ["-s", "format", "png", ...(side > MAX_SIDE ? ["-Z", String(MAX_SIDE)] : []), source, "--out", png], { stdio: "ignore" });
        bytes = readFileSync(png);
        converted = `${isPng ? "" : "to PNG"}${!isPng && side > MAX_SIDE ? ", " : ""}${side > MAX_SIDE ? `${String(side)}px → ${String(MAX_SIDE)}px` : ""}`;
      }
      writeFileSync(join(outDir, `${id}.png`), bytes);
      rows.push({ id, name: typeof manifest.name === "string" ? manifest.name : "", size: Math.min(side, MAX_SIDE), bytes: bytes.length, converted });
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(zipPath, { force: true });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

for (const row of rows) console.log(`${row.id}  ${String(row.size).padStart(4)}px  ${String(row.bytes).padStart(7)} B  ${row.name}${row.converted === "" ? "" : `  (${row.converted})`}`);
console.log(`${rows.length} logo${rows.length === 1 ? "" : "s"} written to ${outDir}, ${rows.reduce((sum, row) => sum + row.bytes, 0)} bytes in all`);
if (skipped.length > 0) {
  console.log(`skipped (keep iconUrl: null):`);
  for (const row of skipped) console.log(`  ${row.id}  ${row.reason}`);
  process.exitCode = 2;
}
