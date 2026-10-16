/**
 * Builds the desktop's own native module, native/desk-glass (the window's glass under the desk's nub over a live page;
 * main/desk-glass.ts), when its source is newer than the binary.
 *
 * It is Node-API only, so it is compiled straight against Node's headers — those of the Node running this script —
 * and loads in Electron as node-pty's prebuilt binary does: no electron-rebuild, no node-gyp. The app ships for Apple
 * silicon (electron-builder.yml), so it is built for arm64. Anywhere it cannot be built (not a Mac, no headers, no
 * clang), it says so and the app does without: the nub keeps its stand-in grey.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(appDirectory, "native/desk-glass/desk_glass.mm");
const output = join(appDirectory, "native/desk-glass/build/desk_glass.node");

function skip(reason) {
  console.warn(`build-native: desk-glass not built (${reason}); the desk's nub keeps its stand-in grey over live pages`);
  process.exit(0);
}

if (process.platform !== "darwin") skip("not macOS");
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0);
const headers = [process.env.NODE_API_HEADERS, join(dirname(process.execPath), "../include/node")].find(
  (candidate) => candidate !== undefined && existsSync(join(candidate, "node_api.h")),
);
if (headers === undefined) skip("no node_api.h beside this Node; set NODE_API_HEADERS to a folder holding it");

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(
  "xcrun",
  [
    "clang++",
    "-std=c++20",
    "-ObjC++",
    "-fobjc-arc",
    "-O2",
    "-shared",
    // Node-API's symbols are the host's (Electron's), found as the module loads.
    "-undefined",
    "dynamic_lookup",
    "-arch",
    "arm64",
    "-mmacosx-version-min=12.0",
    "-DNODE_GYP_MODULE_NAME=desk_glass",
    "-DNAPI_VERSION=8",
    `-I${headers}`,
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    source,
    "-o",
    output,
  ],
  { stdio: "inherit" },
);
if (result.error !== undefined || result.status !== 0) skip(result.error?.message ?? `clang exited ${String(result.status)}`);
console.log(`build-native: built ${output} against ${headers}`);
