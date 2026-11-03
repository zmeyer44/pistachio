// The panel: proves the API in the panel's context, a message to the worker and a port to it.
// A spec reads the dd elements, or the "panel.*" markers in storage. `data-done` on <body> is
// set when every step has run.

const show = (id, value) => {
  document.getElementById(id).textContent = typeof value === "string" ? value : JSON.stringify(value);
};

const port = pistachio.runtime.connect("panel");
port.onMessage((message) => {
  show("port", message);
  pistachio.storage.local.set({ "panel.port": message });
});
port.postMessage({ hello: "worker" });

pistachio.runtime.ready
  .then(async () => {
    show("context", pistachio.runtime.context);
    const tabs = await pistachio.tabs.query();
    show("tabs", String(tabs.length));
    const reply = await pistachio.runtime.sendMessage({ ping: "panel" });
    show("reply", reply);
    await pistachio.storage.local.set({ "panel.opened": { context: pistachio.runtime.context, tabs: tabs.length, reply } });
    document.body.dataset.done = "true";
  })
  .catch((error) => {
    show("reply", `${error.name} ${error.code}: ${error.message}`);
    document.body.dataset.done = "error";
  });
