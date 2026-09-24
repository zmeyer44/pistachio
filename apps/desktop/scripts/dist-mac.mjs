/**
 * Builds the signed macOS app.
 *
 * Touch ID passkeys need the `keychain-access-groups` entitlement, and macOS
 * refuses to launch a Developer ID app carrying that entitlement unless a
 * Developer ID provisioning profile is embedded (launchd error 163). So the
 * passkey entitlements are only applied when a profile is present at
 * build/embedded.provisionprofile (or $PISTACHIO_PROVISIONING_PROFILE).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profile =
  process.env.PISTACHIO_PROVISIONING_PROFILE ??
  resolve(appDirectory, "build/embedded.provisionprofile");
const withPasskeys = existsSync(profile);

const args = ["--mac", "--config", "electron-builder.yml", ...process.argv.slice(2)];
if (withPasskeys) {
  console.log(`dist-mac: embedding ${profile}; Touch ID passkeys enabled`);
  args.push(
    `--config.mac.provisioningProfile=${profile}`,
    // Helpers keep the base entitlements: the profile only covers the main
    // bundle ID, and macOS kills helpers that claim the keychain group.
    "--config.mac.entitlements=entitlements.mac.passkeys.plist",
  );
} else {
  console.warn(
    "dist-mac: no provisioning profile at build/embedded.provisionprofile; building without Touch ID passkey support",
  );
}

const cli = resolve(appDirectory, "node_modules/electron-builder/cli.js");
const result = spawnSync(process.execPath, [cli, ...args], { cwd: appDirectory, stdio: "inherit" });
process.exit(result.status ?? 1);
