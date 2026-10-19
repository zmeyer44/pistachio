import { contextBridge, ipcRenderer } from "electron";
import type { AppearanceSettings } from "@pistachio/shell-contracts/appearance";
import type { IPC } from "@pistachio/shell-contracts/ipc";
import type { LiveHostApi, LiveHostConfig, LiveHostEvent, LiveHostReport } from "@pistachio/shell-contracts/live-share";

/**
 * The live-host window's preload (main/live/live-host-window.ts; docs/live-share.md §6.1, §10). That window is the
 * one renderer that reads what strangers send — guests' packets, names and chat come through livekit-client — so it
 * is sandboxed and given only what LiveHostApp uses: the room's five members, and the appearance its theme is drawn
 * in. Not the shell's API: no tabs, no snapshot, no navigation, nothing of any other space. Main answers each of
 * these channels for this window alone.
 *
 * A sandboxed preload can load no module but Electron's, so nothing here may be shared with the shell's preload
 * (the bundler would put it in a chunk of both): the channels are spelled out, and the compiler holds each equal to
 * its name in `IPC`, which is imported as a type only.
 */
const CONFIG: (typeof IPC)["liveHostConfig"] = "pistachio:live-host-config";
const EVENT: (typeof IPC)["liveHostEvent"] = "pistachio:live-host-event";
const REPORT: (typeof IPC)["liveHostReport"] = "pistachio:live-host-report";
const SOURCE: (typeof IPC)["liveHostSource"] = "pistachio:live-host-source";
const SHELL_SOURCE: (typeof IPC)["liveHostShellSource"] = "pistachio:live-host-shell-source";
const APPEARANCE: (typeof IPC)["liveHostAppearance"] = "pistachio:live-host-appearance";

const api: LiveHostApi = {
  liveHostConfig: () => ipcRenderer.invoke(CONFIG) as Promise<LiveHostConfig | null>,
  onLiveHostEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, event: LiveHostEvent): void => listener(event);
    ipcRenderer.on(EVENT, handler);
    return () => ipcRenderer.removeListener(EVENT, handler);
  },
  sendLiveHostReport: (report: LiveHostReport) => ipcRenderer.send(REPORT, report),
  liveHostSource: async (tabId: string) => {
    const id: unknown = await ipcRenderer.invoke(SOURCE, tabId);
    return typeof id === "string" ? id : null;
  },
  liveHostShellSource: async () => {
    const id: unknown = await ipcRenderer.invoke(SHELL_SOURCE);
    return typeof id === "string" ? id : null;
  },
  liveHostAppearance: () => ipcRenderer.invoke(APPEARANCE) as Promise<AppearanceSettings | null>,
};

contextBridge.exposeInMainWorld("pistachio", api);
