import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { DesktopIconStyle } from "@pistachio/shell-contracts/appearance";

/** Packaged runtime artwork lives outside ASAR; dev artwork lives in build/. */
export function desktopIconPath(style: DesktopIconStyle): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, "icons")
    : join(app.getAppPath(), "build");
  const suffix = style === "green" ? "-green" : "";
  const base = process.platform === "darwin" ? "icon-macos" : "icon";
  // Development always wears Cryo Circuit; the preference applies to releases.
  const filename = `${base}${app.isPackaged ? suffix : "-dev"}.png`;
  const path = join(root, filename);
  return existsSync(path) ? path : null;
}

/** Apply after settings load, and whenever the saved preference changes. */
export function applyDesktopIcon(style: DesktopIconStyle): void {
  const path = desktopIconPath(style);
  if (path === null) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(path);
  } else {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setIcon(path);
    }
  }
}
