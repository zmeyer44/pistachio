// Tidy's filing of idle spaces (docs/tab-tidy.md §4: "Tidy's own auto groups wholly idle are archived as group
// entries, by the clock"), written on the public API alone — stage 6's gate, docs/primitives.md §5. No timer here:
// Pistachio keeps the clock and wakes this every half hour. What it filed is left in storage for a spec to read.

pistachio.triggers.on("sweep", () => sweep());
pistachio.bar.onCommand("idle-spaces", () => sweep());

async function sweep() {
  const hours = Number((await pistachio.settings.get("hours")) ?? 12);
  const idleMs = hours * 60 * 60 * 1000;
  const now = Date.now();
  const current = await pistachio.spaces.current();
  let failed = null;
  for (const space of await pistachio.spaces.list()) {
    // Tidy's rule: a space Pistachio gathered that nobody has made theirs, every tab of it idle — never the one in front.
    if (space.byPerson || space.id === current?.id || space.tabIds.length === 0) continue;
    const tabs = await pistachio.tabs.query({ spaceId: space.id });
    if (!tabs.every((tab) => tab.lastActiveAt > 0 && now - tab.lastActiveAt >= idleMs && !tab.loading)) continue;
    const about = await say(space.name, tabs);
    try {
      await pistachio.spaces.close(space.id);
      await note("filed", { id: space.id, name: space.name, about });
    } catch (error) {
      // Busy, in front, playing: left where it is. Thrown at the end, so Pistachio runs the sweep again later.
      failed = error;
    }
  }
  if (failed !== null) throw failed;
}

// What the space was for, in a few words — asked of a model when one can be, and filed all the same when none can.
async function say(name, tabs) {
  try {
    return await pistachio.ai.complete({ system: "Say in five words or fewer what these tabs were for.", prompt: `${name}: ${tabs.map((tab) => tab.title).join(", ")}`, maxTokens: 30 });
  } catch {
    return null;
  }
}

async function note(key, value) {
  const stored = await pistachio.storage.local.get(key);
  await pistachio.storage.local.set({ [key]: [...(stored[key] ?? []), value] });
}
