/**
 * Builds the desktop's own native modules when their source is newer than the binary:
 *
 * - native/desk-glass: the window's glass under the desk's nub over a live page (main/desk-glass.ts);
 * - native/os-keys: the modifier keys as the OS has them now (main/os-keys.ts).
 *
 * They are Node-API only, so they are compiled straight against Node's headers — those of the Node running this
 * script — and load in Electron as node-pty's prebuilt binary does: no electron-rebuild, no node-gyp. The app ships for
 * Apple silicon (electron-builder.yml), so they are built for arm64. Anywhere one cannot be built (not a Mac, no
 * headers, no clang), it says so and the app does without, as each module's `without` says.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MODULES = [
  {
    name: "desk-glass",
    file: "desk_glass",
    frameworks: ["AppKit", "QuartzCore"],
    without: "the desk's nub keeps its stand-in grey over live pages",
  },
  {
    name: "os-keys",
    file: "os_keys",
    frameworks: ["AppKit"],
    without: "the desk follows its grab key from the key events alone",
  },
];

const headers = [process.env.NODE_API_HEADERS, join(dirname(process.execPath), "../include/node")].find(
  (candidate) => candidate !== undefined && existsSync(join(candidate, "node_api.h")),
);

for (const module of MODULES) {
  const source = join(appDirectory, `native/${module.name}/${module.file}.mm`);
  const output = join(appDirectory, `native/${module.name}/build/${module.file}.node`);
  const skip = (reason) => console.warn(`build-native: ${module.name} not built (${reason}); ${module.without}`);

  if (process.platform !== "darwin") {
    skip("not macOS");
    continue;
  }
  if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) continue;
  if (headers === undefined) {
    skip("no node_api.h beside this Node; set NODE_API_HEADERS to a folder holding it");
    continue;
  }

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
      `-DNODE_GYP_MODULE_NAME=${module.file}`,
      "-DNAPI_VERSION=8",
      `-I${headers}`,
      ...module.frameworks.flatMap((framework) => ["-framework", framework]),
      source,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  if (result.error !== undefined || result.status !== 0) {
    skip(result.error?.message ?? `clang exited ${String(result.status)}`);
    continue;
  }
  console.log(`build-native: built ${output} against ${headers}`);
}
