/**
 * Bundled extensions (docs/extensions.md §4 "The protocol", X8): every folder
 * under apps/desktop/extensions/<id>/ is built into out/extensions/<id>/,
 * which the pistachio-ext protocol serves in dev and which electron-builder
 * packages into Resources/extensions/. A folder with a `build.json` names the
 * entry files esbuild bundles (so an extension may import npm packages such as
 * mediabunny); everything else in the folder is copied as it is, minus the
 * sources that were bundled. A folder without one is copied whole.
 *
 *   build.json: { "entries": ["worker.ts", "src/editor/main.ts"], "exclude": ["src/**", "test/**"] }
 *
 * Run by `pnpm build` and by the dev wrapper (scripts/electron-vite.mjs);
 * `--watch` rebuilds on change for `pnpm dev`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = join(appDirectory, "extensions");
const outRoot = join(appDirectory, "out/extensions");
const watchMode = process.argv.includes("--watch");

const require = createRequire(import.meta.url);
/** esbuild as vite brings it (the desktop has no direct dependency of its own). */
function esbuild() {
  try {
    return require("esbuild");
  } catch {
    const viteDir = require.resolve("vite/package.json");
    return require(require.resolve("esbuild", { paths: [viteDir] }));
  }
}

function readBuildConfig(folder) {
  const file = join(folder, "build.json");
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, "utf8"));
  return { entries: Array.isArray(config.entries) ? config.entries : [], exclude: Array.isArray(config.exclude) ? config.exclude : [] };
}

/** A tiny glob: `**` crosses folders, `*` does not. */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (/[.+^${}()|[\]\\]/.test(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

function copyFolder(from, to, excluded) {
  const patterns = excluded.map(globToRegExp);
  const skip = (path) => {
    const rel = relative(from, path).split("\\").join("/");
    if (rel === "" ) return false;
    if (rel === "build.json" || rel.startsWith("node_modules") || rel.startsWith(".")) return true;
    // A folder matches when its contents would (`test/**` keeps the empty `test/` out as well).
    return patterns.some((pattern) => pattern.test(rel) || pattern.test(`${rel}/`));
  };
  cpSync(from, to, { recursive: true, filter: (source) => !skip(source) });
}

async function buildOne(id) {
  const folder = join(sourceRoot, id);
  if (!statSync(folder).isDirectory() || !existsSync(join(folder, "pistachio.json"))) return;
  const out = join(outRoot, id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const config = readBuildConfig(folder);
  if (config === null) {
    copyFolder(folder, out, []);
    return;
  }
  copyFolder(folder, out, [...config.exclude, ...config.entries]);
  if (config.entries.length === 0) return;
  const { build } = esbuild();
  await build({
    entryPoints: config.entries.map((entry) => join(folder, entry)),
    outdir: out,
    outbase: folder,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome150",
    sourcemap: "inline",
    logLevel: "warning",
    // `.ts` entries become `.js` next to where they were; pages reference `worker.js`, `src/editor/main.js`.
    outExtension: { ".js": ".js" },
    absWorkingDir: folder,
    nodePaths: [join(appDirectory, "node_modules"), join(appDirectory, "../../node_modules")],
  });
}

async function buildAll() {
  if (!existsSync(sourceRoot)) return;
  mkdirSync(outRoot, { recursive: true });
  for (const id of readdirSync(sourceRoot)) {
    if (!statSync(join(sourceRoot, id)).isDirectory() || !existsSync(join(sourceRoot, id, "pistachio.json"))) continue;
    try {
      await buildOne(id);
      console.log(`[extensions] built ${id}`);
    } catch (error) {
      console.error(`[extensions] ${id} failed:`, error instanceof Error ? error.message : error);
      if (!watchMode) process.exitCode = 1;
    }
  }
}

await buildAll();

if (watchMode && existsSync(sourceRoot)) {
  let timer = null;
  watch(sourceRoot, { recursive: true }, (_event, file) => {
    if (typeof file === "string" && (file.includes("node_modules") || file.startsWith("."))) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void buildAll(), 200);
  });
  console.log("[extensions] watching", relative(appDirectory, sourceRoot));
}
