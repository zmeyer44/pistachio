/**
 * Tidy (docs/tab-tidy.md): the scheduled — or asked-for — pass that archives
 * idle tabs, gathers related ones into tab groups, and sends favorites home.
 *
 * Both hosts would answer `ShellApi.tidy` with the same judge
 * (@pistachio/agent-runtime/tab-tidy), so the wire shapes and the pure plan
 * policy live beside it — the way `./address-intent.ts` does — and this
 * module is the name the shell says them under. The contract imports nothing
 * from the AI SDK, so a page that reads these shapes drags no model code into
 * the renderer.
 */

export * from "@pistachio/agent-runtime/tab-tidy-contract";
