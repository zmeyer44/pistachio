/* global chrome */
// Mini Action's popup: records that it opened (chrome.storage.local `popupOpens`), pings the worker, and says both on
// the page (`data-popup` on <body>: "ready" once done).
const status = document.getElementById("status");

async function main() {
  const { popupOpens = 0, pageMarks = 0 } = await chrome.storage.local.get(["popupOpens", "pageMarks"]);
  await chrome.storage.local.set({ popupOpens: popupOpens + 1 });
  const pong = await chrome.runtime.sendMessage({ type: "ping" }).catch(() => null);
  status.textContent = `Opened ${popupOpens + 1} time(s); pages marked: ${pageMarks}; worker: ${pong?.type ?? "silent"}`;
  // The page the popup was opened on, as `activeTab` lets the popup see it (`data-active-url`: its address, or "none").
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  document.body.dataset.activeUrl = active?.url ?? "none";
  // ...and whether a query by that address finds it (`data-active-by-url`: how many it found).
  const byUrl = active?.url ? await chrome.tabs.query({ url: active.url }).catch(() => []) : [];
  document.body.dataset.activeByUrl = String(byUrl.length);
  // ...and whether it may style that page by the click's grant alone (`data-active-css`: "1", or the refusal).
  document.body.dataset.activeCss = active?.id === undefined ? "none" : await chrome.tabs.insertCSS(active.id, { code: "body { outline: 3px solid rgb(1, 2, 3) }" }).then(() => "1", (error) => String(error?.message ?? error));
  // ...and run a script in it by the same grant (`data-active-script`: the page's title it read, or the refusal).
  document.body.dataset.activeScript =
    active?.id === undefined
      ? "none"
      : await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => document.title }).then((results) => String(results?.[0]?.result ?? "none"), (error) => String(error?.message ?? error));
  document.body.dataset.popup = "ready";
}

main().catch((error) => {
  status.textContent = `Error: ${error?.message ?? error}`;
  document.body.dataset.popup = "error";
});
