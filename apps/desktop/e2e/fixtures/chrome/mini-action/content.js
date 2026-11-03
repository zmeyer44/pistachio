/* global chrome */
// Mini Action's content script: marks the page (a test reads `data-mini-action` on <html>) and counts its runs in
// chrome.storage.local, read back as `data-mini-storage`.
document.documentElement.dataset.miniAction = "ran";
chrome.storage.local
  .get("pageMarks")
  .then(({ pageMarks = 0 }) => chrome.storage.local.set({ pageMarks: pageMarks + 1 }).then(() => pageMarks + 1))
  .then((count) => {
    document.documentElement.dataset.miniStorage = String(count);
  })
  .catch((error) => {
    document.documentElement.dataset.miniStorage = `error: ${error?.message ?? error}`;
  });
chrome.runtime.sendMessage({ type: "content-ran", url: location.href }).catch(() => undefined);
