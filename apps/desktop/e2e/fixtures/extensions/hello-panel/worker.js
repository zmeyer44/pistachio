// Every path below leaves a marker in pistachio.storage.local, which a spec reads back
// (storage is main's, the same from every context): "worker.started" proves the worker
// loaded with the API, the rest prove one wire path each.

pistachio.runtime.onInstalled(({ reason }) => pistachio.storage.local.set({ "worker.installed": reason }));

pistachio.bar.onCommand("hello", async ({ arg, tabId, spaceId }) => {
  await pistachio.storage.local.set({ "bar.hello": { arg, tabId, spaceId } });
  await pistachio.ui.toast({ title: arg ? `Hello, ${arg}!` : "Hello!" });
  if (arg) await pistachio.ui.openPage("hello", { query: `name=${encodeURIComponent(arg)}` });
});

// From the panel: a one-shot message, answered.
pistachio.runtime.onMessage(async (message, from) => {
  await pistachio.storage.local.set({ "worker.message": { message, from } });
  return { pong: message };
});

// From the panel: a port, main off the path; every message is echoed back.
pistachio.runtime.onConnect((port) => {
  port.onMessage(async (message) => {
    port.postMessage({ echo: message, name: port.name });
    await pistachio.storage.local.set({ "worker.port": { name: port.name, message } });
  });
});

pistachio.runtime.ready.then(() =>
  pistachio.storage.local.set({
    "worker.started": { id: pistachio.runtime.id, context: pistachio.runtime.context, at: pistachio.runtime.now() },
  }),
);
