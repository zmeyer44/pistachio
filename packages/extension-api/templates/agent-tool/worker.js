// The worker: wakes when the agent calls word_count. Return JSON; throw to fail the step.
// Needs only "agent:tools" — the counting happens here, nothing leaves the Mac.

pistachio.agent.onToolCall("word_count", async ({ text }) => {
  if (typeof text !== "string") throw new Error("word_count needs { text: string }");
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim() !== "").length;
  return { words, sentences, characters: text.length };
});
