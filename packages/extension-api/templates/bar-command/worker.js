// The worker: wakes when /hello runs in the Bar ("run": { "event": true }).
// No permissions needed: a declared command, a toast and the extension's own page are free.

pistachio.bar.onCommand("hello", async ({ arg }) => {
  const name = arg.trim();
  await pistachio.ui.toast({ title: name ? `Hello, ${name}!` : "Hello!" });
  if (name) await pistachio.ui.openPage("hello", { query: `name=${encodeURIComponent(name)}` });
});
