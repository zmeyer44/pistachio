// The probe's panel: as it loads it asks for the sources, as a chooser would, and says how many came with a picture —
// every one when the person opened the panel; none when the worker opened it on its own (docs/extensions.md §5).
await pistachio.runtime.ready;
try {
  const list = await pistachio.capture.sources();
  const data = { total: list.length, pictured: list.filter((source) => source.still !== null).length, list: list.map((source) => ({ tabId: source.tabId, still: source.still !== null })) };
  pistachio.runtime.log("info", "probe: panel", data);
  document.getElementById("panel").textContent = `sources ${String(data.total)}, pictured ${String(data.pictured)}`;
} catch (error) {
  pistachio.runtime.log("info", "probe: panel", { error: String(error?.message ?? error) });
}
