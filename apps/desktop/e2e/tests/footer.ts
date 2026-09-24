import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The sidebar footer's one menu, opened from the active Space's avatar: the
 * Space (and who is signed in) on top, the Spaces to switch to, then the
 * controls — the agent panel, reminders, settings. A row closes the menu
 * when picked, so each pick opens it again. Locate within `shell` (the
 * shell page) or a narrower scope such as the sidebar column.
 */
export async function openSidebarMenu(scope: Page | Locator): Promise<Locator> {
  const menu = scope.getByTestId("sidebar-menu");
  if (await menu.isVisible()) return menu;
  await scope.getByTestId("sidebar-menu-button").click();
  await expect(menu).toBeVisible();
  return menu;
}

/** A row of the sidebar footer's menu, ready to click. */
export async function sidebarMenuItem(scope: Page | Locator, testId: string): Promise<Locator> {
  const menu = await openSidebarMenu(scope);
  const item = menu.getByTestId(testId);
  await expect(item).toBeVisible();
  return item;
}
