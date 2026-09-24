/**
 * What the typed words in the address bar most likely MEAN, as judged by a
 * System One evaluation model (TypeSafe's Jev, through the Vercel AI Gateway:
 * docs/smart-suggestions.md).
 *
 * The address bar's own heuristics still decide everything they can decide
 * alone — a typed or pasted address is a place to go, and no model is asked.
 * What they cannot tell apart is prose: "best pistachio gelato" is a web
 * search, "explain how tls handshakes work" is a prompt for an assistant,
 * "change theme color" is a settings page, "my email" is the Gmail tab. For
 * those the shell sends the typed text, a little context, and the candidates
 * it could offer, and gets back a probability for each reading. The shell —
 * never the model — decides what to do with them (lib/intent-ranking).
 *
 * The model picks only among ids the shell sent. It writes no text, names no
 * address, and runs nothing; the worst a wrong (or manipulated — page titles
 * are untrusted) answer can do is put the wrong row first.
 *
 * Both hosts answer `ShellApi.rankAddressIntent` with the same evaluator
 * (@pistachio/agent-runtime/address-intent), so the wire shapes and the
 * bounds each host enforces live beside it — the way `./bookmarks.ts` and
 * `./memory.ts` live beside the views that write them — and this module is
 * the name the shell says them under. The contract itself imports nothing
 * from the AI SDK, so a page that reads these shapes drags no model code
 * into the renderer.
 */

export * from "@pistachio/agent-runtime/address-intent-contract";
