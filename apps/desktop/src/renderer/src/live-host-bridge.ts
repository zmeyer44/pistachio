import { DEFAULT_APPEARANCE } from "@pistachio/shell-contracts/appearance";
import { NATIVE_SURFACE_MEMBERS, type NativeSurfaceApi, type ShellApi } from "@pistachio/shell-contracts/ipc";
import type { LiveHostApi } from "@pistachio/shell-contracts/live-share";
import type { DesktopSettings } from "@pistachio/shell-contracts/settings";

/**
 * The live share's room window's bridge (main/live/live-host-window.ts). Its
 * preload is its own and narrow (preload/live-host.ts): the room's members
 * and the appearance, never the shell's API. The pieces this bundle mounts
 * there read the bridge as the shell's pages do — the theme its settings,
 * LiveHostApp the native surface, which shell-ui takes whole or not at all
 * (api.ts) — so it is made whole here: the room's members are the preload's,
 * the settings are the appearance alone, and every other native member throws,
 * as nothing in that window calls one. The rest of the shell's API is not
 * there at all: nothing in the window reads it.
 */
export function liveHostBridge(api: LiveHostApi): ShellApi & NativeSurfaceApi {
  const absent = Object.fromEntries(
    Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [
      member,
      () => {
        throw new Error(`${member} is not the live-host window's`);
      },
    ]),
  );
  const bridge = {
    ...absent,
    liveHostConfig: api.liveHostConfig,
    onLiveHostEvent: api.onLiveHostEvent,
    sendLiveHostReport: api.sendLiveHostReport,
    liveHostSource: api.liveHostSource,
    liveHostShellSource: api.liveHostShellSource,
    // (ThemeRuntime reads the appearance alone.)
    getSettings: async () => ({ appearance: (await api.liveHostAppearance()) ?? DEFAULT_APPEARANCE }) as DesktopSettings,
    // The window lives one share: the theme it opened in stays, as no change of settings is sent it.
    onSettings: () => () => undefined,
  };
  return bridge as unknown as ShellApi & NativeSurfaceApi;
}
