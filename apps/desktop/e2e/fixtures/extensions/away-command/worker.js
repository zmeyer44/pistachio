// Every command leaves what happened in pistachio.storage.local for a spec to read back: `{ ok }` with what the call
// answered, or `{ error: { code, message } }` with what it threw.

async function mark(key, work) {
  let value;
  try {
    value = { ok: await work() };
  } catch (error) {
    value = { error: { code: error?.code ?? null, message: String(error?.message ?? error) } };
  }
  await pistachio.storage.local.set({ [key]: { ...value, at: pistachio.runtime.now() } });
}

// Run in a space, the command gives the extension that space (ctx.spaceId): away for two seconds, back by main's clock.
pistachio.bar.onCommand("gameday", ({ spaceId }) =>
  mark("gameday", async () => {
    const sent = await pistachio.spaces.sendAway(spaceId, { until: Date.now() + 2000 });
    return { sent, away: await pistachio.spaces.away() };
  }),
);

// Away until asked: nothing of the extension's brings it back.
pistachio.bar.onCommand("benched", ({ spaceId }) => mark("benched", () => pistachio.spaces.sendAway(spaceId)));

// A space named in words, not the one the command was run in: never given, so refused.
pistachio.bar.onCommand("sendother", ({ arg }) => mark("sendother", () => pistachio.spaces.sendAway(arg.trim())));

// What main says of spaces going and coming, the last of each.
pistachio.spaces.onAwayChanged((change) => pistachio.storage.local.set({ [`changed.${change.event}`]: change }));

pistachio.runtime.ready.then(() => pistachio.storage.local.set({ "worker.started": { id: pistachio.runtime.id, at: pistachio.runtime.now() } }));
