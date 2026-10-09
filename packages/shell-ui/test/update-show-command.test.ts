import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateState } from "@pistachio/shell-contracts/updates";
import { NATIVE_SURFACE_MEMBERS } from "@pistachio/shell-contracts/ipc";
import { setShellApi, type ShellApiBridge } from "../src/api";
import { runShellCommand } from "../src/chrome/shell-host";
import { useAppStore } from "../src/store";

const due: UpdateState = { status: "available", version: "0.0.31", releaseDate: null, prompt: { due: true, snoozes: 0 } };

/** The update's notification clicked: main asks for the update's controls (`showUpdate`). */
describe("showUpdate", () => {
  beforeEach(() => {
    useAppStore.setState({ overlay: "none", update: due, onboardingOpen: false, glance: null, settingsSection: "" });
    setShellApi({} as unknown as ShellApiBridge);
  });

  it("raises the update dialog, put off or not, over whatever was raised", () => {
    useAppStore.setState({ overlay: "settings", update: { ...due, prompt: { due: false, snoozes: 2 } } });
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState().overlay).toBe("update");
  });

  it("raises the dialog on the desk too: the desktop's surface since 2026-10-09, a page over which stands as Settings does", () => {
    // A native bridge: the desk is up (lib/desk/open.ts deskAvailable).
    setShellApi(Object.fromEntries(Object.keys(NATIVE_SURFACE_MEMBERS).map((member) => [member, () => undefined])) as unknown as ShellApiBridge);
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState().overlay).toBe("update");
  });

  it("opens About in Settings where the dialog never stands: a Glance open, the first-run wizard", () => {
    useAppStore.setState({ overlay: "none", onboardingOpen: true });
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState()).toMatchObject({ overlay: "settings", settingsSection: "about" });
  });

  it("opens About when there is no update for the dialog to show", () => {
    useAppStore.setState({ update: { status: "up-to-date", checkedAt: "2026-10-04T00:00:00.000Z" } });
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState()).toMatchObject({ overlay: "settings", settingsSection: "about" });
  });
});
