#!/usr/bin/env node
/**
 * Run only the tests a change concerns: `pnpm test:changed`.
 *
 *   Unit tests — turbo runs `test` in the packages the change touches and the
 *   packages that depend on them (`--filter=...[base]`), and vitest runs only
 *   the test files that import a changed file, directly or through other
 *   packages (`--changed base`). A change to the repo's own config (turbo.json,
 *   the lockfile, a package.json) runs everything, as turbo decides.
 *
 *   Desktop e2e — the changed files are read against apps/desktop/e2e/areas.mjs:
 *   each area a file belongs to runs its tagged tests, a changed spec runs
 *   itself, a changed e2e helper runs the specs that import it, and any desktop
 *   code at all runs the `@smoke` tests. Live tests (`@live`) never run here.
 *
 * The base is what the change is measured against. On a branch it is where the
 * branch left main; on main it is HEAD, so the change is what is not committed
 * yet. Uncommitted and untracked files always count. `--base <ref>` picks one.
 *
 * Options:
 *   --base <ref>   measure against this ref
 *   --unit         unit tests only        --e2e       e2e only
 *   --dry          print the plan and the e2e tests it would run, run nothing
 *   --explain      also print which area each changed file fell into
 *   --files a,b    plan e2e for these paths instead of the git change (with --dry: "what would this run?")
 *   --no-build     skip building the desktop app before e2e (it must be current)
 *
 * The whole suite is still `pnpm test` and `pnpm test:e2e`: run it before
 * merging, since a hub file's change is only smoke-tested here.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AREAS, HUB_PATHS, IGNORE_PATHS, WHOLE_SUITE_PATHS } from "../apps/desktop/e2e/areas.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "apps/desktop");
const E2E_TESTS = "apps/desktop/e2e/tests/";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" }).trim();

function baseRef() {
  const chosen = option("--base");
  if (chosen !== undefined) return chosen;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "main") return "HEAD";
  try {
    return git("merge-base", "HEAD", "main");
  } catch {
    return "HEAD";
  }
}

function changedFiles(base) {
  const tracked = git("diff", "--name-only", base).split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((file) => file !== "");
}

/** A glob as a regular expression: `**` crosses folders, `*` does not, `{a,b}` is either. */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") out += "[^/]*";
    else if (char === "{") out += "(?:";
    else if (char === "}") out += ")";
    else if (char === "," && out.lastIndexOf("(?:") > out.lastIndexOf(")")) out += "|";
    else out += char.replace(/[.+?^$()|[\]\\]/u, "\\$&");
  }
  return new RegExp(`^${out}$`, "u");
}

const matcher = (globs) => {
  const patterns = globs.map(globToRegExp);
  return (file) => patterns.some((pattern) => pattern.test(file));
};

const isIgnored = matcher(IGNORE_PATHS);
const isHub = matcher(HUB_PATHS);
const isWholeSuite = matcher(WHOLE_SUITE_PATHS);
const areaMatchers = AREAS.map((area) => ({ tag: area.tag, matches: matcher(area.paths) }));
/** Code the desktop app is built from: unclaimed files here are smoke-tested. */
const isDesktopCode = matcher(["apps/desktop/src/**", "packages/shell-ui/src/**", "packages/shell-contracts/src/**"]);

/** Specs that import an e2e helper module (`./name`). */
function specsImporting(helper) {
  const name = helper.slice(E2E_TESTS.length).replace(/\.ts$/u, "");
  const dir = join(ROOT, E2E_TESTS);
  const imports = new RegExp(`from "\\./${name}"`, "u");
  return readdirSync(dir).filter((file) => file.endsWith(".spec.ts") && imports.test(readFileSync(join(dir, file), "utf8")));
}

function e2ePlan(files) {
  const tags = new Set();
  const specs = new Set();
  const explain = [];
  let whole = false;
  for (const file of files) {
    if (isWholeSuite(file)) {
      whole = true;
      explain.push([file, "whole e2e suite"]);
      continue;
    }
    if (file.startsWith(E2E_TESTS)) {
      if (file.endsWith(".spec.ts")) {
        if (existsSync(join(ROOT, file))) specs.add(file.slice(E2E_TESTS.length));
        explain.push([file, "itself"]);
      } else {
        const importers = specsImporting(file);
        for (const spec of importers) specs.add(spec);
        tags.add("@smoke");
        explain.push([file, `@smoke + ${importers.length} specs importing it`]);
      }
      continue;
    }
    if (isIgnored(file)) {
      explain.push([file, "—"]);
      continue;
    }
    const hit = areaMatchers.filter((area) => area.matches(file)).map((area) => area.tag);
    // Anything the desktop app is built from also runs the smoke pass: a hub
    // file runs only that, a file no area claims too.
    if (isHub(file) || isDesktopCode(file) || hit.some((tag) => tag !== "@web")) hit.push("@smoke");
    for (const tag of hit) tags.add(tag);
    explain.push([file, hit.length === 0 ? "—" : hit.join(" ")]);
  }
  return { whole, tags: [...tags].sort(), specs: [...specs].sort(), explain };
}

function run(command, commandArgs, cwd) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const base = baseRef();
const files = option("--files")?.split(",").filter((file) => file !== "") ?? changedFiles(base);
// `--files` plans the e2e side only: vitest's own `--changed` reads git.
const wantUnit = !flag("--e2e") && option("--files") === undefined;
const wantE2e = !flag("--unit");
const dry = flag("--dry");

console.log(`Changes against ${base === "HEAD" ? "HEAD (uncommitted)" : base}: ${files.length} file${files.length === 1 ? "" : "s"}`);
if (files.length === 0) {
  console.log("Nothing changed, nothing to test.");
  process.exit(0);
}

const plan = e2ePlan(files);
if (flag("--explain")) for (const [file, why] of plan.explain) console.log(`  ${file}  →  ${why}`);

let status = 0;

if (wantUnit) {
  // One package at a time: each vitest already spreads over every core, and
  // running several at once was slower (185–200 s against 103 s for the whole
  // set) and let timing-sensitive tests time out.
  const unitArgs = ["turbo", "run", "test", `--filter=...[${base}]`, "--concurrency=1", "--continue", "--", "--changed", base];
  if (dry) console.log(`\nUnit: pnpm exec ${unitArgs.join(" ")}`);
  else status ||= run("pnpm", ["exec", ...unitArgs], ROOT);
}

if (wantE2e) {
  const grep = plan.whole ? null : [...plan.tags.map(escape), ...plan.specs.map(escape)].join("|");
  if (grep === "") {
    console.log("\ne2e: nothing in the desktop app changed.");
  } else {
    const selection = plan.whole ? ["(whole suite)"] : [...plan.tags, ...plan.specs];
    console.log(`\ne2e: ${selection.join(" ")}`);
    const playwright = ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--grep-invert", "@live"];
    if (grep !== null) playwright.push("--grep", grep);
    if (dry) {
      run("pnpm", [...playwright, "--list"], DESKTOP);
    } else {
      if (!flag("--no-build")) status ||= run("pnpm", ["build"], DESKTOP);
      if (status === 0) status ||= run("pnpm", playwright, DESKTOP);
    }
  }
}

process.exit(status);
