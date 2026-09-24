import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  packaged: true,
  setDockIcon: vi.fn(),
  setWindowIcon: vi.fn(),
  setDestroyedWindowIcon: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() { return runtime.packaged; },
    getAppPath: () => "/dev/pistachio",
    dock: { setIcon: runtime.setDockIcon },
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, setIcon: runtime.setWindowIcon },
      { isDestroyed: () => true, setIcon: runtime.setDestroyedWindowIcon },
    ],
  },
}));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
import { applyDesktopIcon, desktopIconPath } from "../src/main/desktop-icon";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (resources) Object.defineProperty(process, "resourcesPath", resources);
  else Reflect.deleteProperty(process, "resourcesPath");
  runtime.packaged = true;
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
});
function host(name: string) {
  Object.defineProperty(process, "platform", { configurable: true, value: name });
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/installed/Resources" });
}

describe("desktop icons", () => {
  it("loads both macOS choices from the installed resources and applies them to the Dock", () => {
    host("darwin");
    applyDesktopIcon("white");
    applyDesktopIcon("green");
    expect(runtime.setDockIcon.mock.calls).toEqual([
      [join("/installed/Resources", "icons", "icon-macos.png")],
      [join("/installed/Resources", "icons", "icon-macos-green.png")],
    ]);
    expect(runtime.setWindowIcon).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32", "linux"])("uses Cryo Circuit for either preference on %s dev runs", (platform) => {
    host(platform);
    runtime.packaged = false;
    const filename = platform === "darwin" ? "icon-macos-dev.png" : "icon-dev.png";
    expect(desktopIconPath("white")).toBe(join("/dev/pistachio/build", filename));
    expect(desktopIconPath("green")).toBe(join("/dev/pistachio/build", filename));
  });

  it.each(["win32", "linux"])("updates live %s windows with the selected square artwork", (platform) => {
    host(platform);
    applyDesktopIcon("green");
    expect(runtime.setWindowIcon).toHaveBeenCalledWith(join("/installed/Resources/icons", "icon-green.png"));
    expect(runtime.setDestroyedWindowIcon).not.toHaveBeenCalled();
    expect(runtime.setDockIcon).not.toHaveBeenCalled();
  });

  it("keeps the bundled OS icon if a runtime asset is missing", () => {
    host("darwin");
    vi.mocked(existsSync).mockReturnValue(false);
    applyDesktopIcon("green");
    expect(runtime.setDockIcon).not.toHaveBeenCalled();
  });
});
