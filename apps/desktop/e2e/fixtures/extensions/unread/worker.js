// "Mark the tabs I have not read" (stage 4b's gate, docs/primitives.md §5), on the public API alone. A tab that opens
// behind what the person is doing gets a mark on its row; the mark comes off when the tab comes in front. Three events
// and one render site: nothing here watches the tabs, and nothing stays running.

const MARK = { tone: "blue", label: "Not read yet" };

// /later <address>: opened behind what is in front — and so, by the event below, marked.
pistachio.bar.onCommand("later", async ({ arg, spaceId }) => {
  await pistachio.tabs.create({ url: arg, ...(spaceId ? { space: spaceId } : {}), show: false });
});

// A tab opened: marked unless it is the one in front (the person opened it to look at it).
pistachio.triggers.on("opened", async ({ events }) => {
  for (const { tabId } of events) {
    const tab = await pistachio.tabs.get(tabId).catch(() => null);   // closed again already: nothing to mark
    if (tab === null || tab.active || tab.kind !== "page") continue;
    await pistachio.tabs.setMark(tabId, MARK);
    await note("marked", tabId);
  }
});

// A tab came in front: it is read. (Taking a mark off a tab that has none, or has gone, is quiet.)
pistachio.triggers.on("shown", async ({ events }) => {
  for (const { tabId } of events) {
    await pistachio.tabs.setMark(tabId, null);
    await note("read", tabId);
  }
});

// A tab closed: Pistachio took its mark with it — nothing to do but remember, for the spec.
pistachio.triggers.on("closed", ({ events }) => Promise.all(events.map(({ tabId }) => note("closed", tabId))));

async function note(key, value) {
  const stored = await pistachio.storage.local.get(key);
  await pistachio.storage.local.set({ [key]: [...(stored[key] ?? []), value] });
}
