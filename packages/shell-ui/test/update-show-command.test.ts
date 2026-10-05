import { beforeEach, describe, expect, it } from "vitest";
import type { UpdateState } from "@pistachio/shell-contracts/updates";
import { runShellCommand } from "../src/chrome/shell-host";
import { useDeskStore } from "../src/lib/desk/store";
import { useAppStore } from "../src/store";

const due: UpdateState = { status: "available", version: "0.0.31", releaseDate: null, prompt: { due: true, snoozes: 0 } };

/** The update's notification clicked: main asks for the update's controls (`showUpdate`). */
describe("showUpdate", () => {
  beforeEach(() => {
    useAppStore.setState({ overlay: "none", update: due, onboardingOpen: false, glance: null, settingsSection: "" });
    useDeskStore.setState({ opening: null, groupId: null });
  });

  it("raises the update dialog, put off or not, over whatever was raised", () => {
    useAppStore.setState({ overlay: "settings", update: { ...due, prompt: { due: false, snoozes: 2 } } });
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState().overlay).toBe("update");
  });

  it("opens About in Settings where the dialog never stands: a desk up, a Glance open, the first-run wizard", () => {
    useDeskStore.setState({ groupId: "work" });
    runShellCommand({ type: "showUpdate" });
    expect(useAppStore.getState()).toMatchObject({ overlay: "settings", settingsSection: "about" });

    useDeskStore.setState({ groupId: null });
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
