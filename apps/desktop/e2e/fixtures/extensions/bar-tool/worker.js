// Every path below leaves a marker in pistachio.storage.local for a spec to read back.

// A Bar command of kind event. With text: a toast. Without: the answer is a prompt for the agent.
pistachio.bar.onCommand("shout", async ({ arg, tabId, spaceId }) => {
  await pistachio.storage.local.set({ "bar.shout": { arg, tabId, spaceId } });
  if (arg.trim() === "") return { prompt: "Say something, loudly." };
  await pistachio.ui.toast({ title: arg.toUpperCase() });
});

// A declared tool: JSON in, JSON out; a throw fails the agent's step with its message.
pistachio.agent.onToolCall("shout_text", async ({ text }, { runId, spaceId, signal, progress }) => {
  progress("Shouting");
  if (text === "fail") {
    await pistachio.storage.local.set({ "tool.failed": { runId } });
    throw new Error("shout_text was asked to fail");
  }
  const result = { text: String(text).toUpperCase(), letters: String(text).replace(/[^a-z]/gi, "").length };
  await pistachio.storage.local.set({ "tool.shout_text": { text, runId, spaceId, aborted: signal.aborted, result } });
  return result;
});

pistachio.runtime.ready.then(() =>
  pistachio.storage.local.set({ "worker.started": { id: pistachio.runtime.id, context: pistachio.runtime.context, at: pistachio.runtime.now() } }),
);
