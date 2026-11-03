/* global chrome */
// Mini Action's service worker: a context menu item, a badge, and answers to the popup and the content script.
// Made at every start, not in runtime.onInstalled: Electron 43 never fires onInstalled for a loaded extension
// (measured 2026-10-30), and Chrome keeps a menu item across restarts only because onInstalled made it once.
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: "mini-action", title: "Mini Action: mark this page", contexts: ["page"] });
});
chrome.action.setBadgeText({ text: "1" });
chrome.action.setBadgeBackgroundColor({ color: "#52a862" });

chrome.contextMenus.onClicked.addListener((info) => {
  void chrome.storage.local.set({ menuClickedOn: info.pageUrl ?? null });
});

// Every tabs.onUpdated as the worker hears it (the last 40): with `activeTab` granted on the tab, a navigation's
// address is in `changeInfo`; without, only its status and the like.
let updates = Promise.resolve();
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  updates = updates.then(async () => {
    const { tabUpdates = [] } = await chrome.storage.local.get("tabUpdates");
    tabUpdates.push({ tabId, url: changeInfo.url ?? null, status: changeInfo.status ?? null });
    await chrome.storage.local.set({ tabUpdates: tabUpdates.slice(-40) });
  });
});

// Every webNavigation.onCommitted and onCompleted as the worker hears them (the last 40): a tab of the person's that is
// no tab to extensions — one of Pistachio's own pages — must never appear here, nor any navigation twice.
chrome.webNavigation.onCommitted.addListener((details) => {
  updates = updates.then(async () => {
    const { navEvents = [] } = await chrome.storage.local.get("navEvents");
    navEvents.push({ kind: "committed", tabId: details.tabId, frameId: details.frameId, url: details.url });
    await chrome.storage.local.set({ navEvents: navEvents.slice(-40) });
  });
});
chrome.webNavigation.onCompleted.addListener((details) => {
  updates = updates.then(async () => {
    const { navEvents = [] } = await chrome.storage.local.get("navEvents");
    navEvents.push({ kind: "completed", tabId: details.tabId, frameId: details.frameId, url: details.url });
    await chrome.storage.local.set({ navEvents: navEvents.slice(-40) });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ type: "pong", at: Date.now() });
    return false;
  }
  if (message?.type === "content-ran") {
    void chrome.storage.local.get("contentRuns").then(({ contentRuns = 0 }) => chrome.storage.local.set({ contentRuns: contentRuns + 1, lastPage: message.url }));
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
