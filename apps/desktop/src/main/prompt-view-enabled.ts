/**
 * Whether the desk's prompt lies over the live pages in a view of its own (./desk-bar-view.ts) — so that no window
 * moves or changes size for it — rather than in a band the desk keeps clear for it.
 *
 * In the app: yes, unless PISTACHIO_PROMPT_VIEW=0 turns it off (the shell's own prompt then, as on the web).
 *
 * Under Playwright: no, unless a spec asks for it (PISTACHIO_E2E_PROMPT_VIEW=1). The specs that write in the Bar
 * were written against the shell's own field, in the shell's own document, and that pill is still what the web draws
 * and what stands in wherever the view cannot be had. So a window seen to glide up for the pill during a test run is
 * that pill, by this switch — not the app's. What the app does is desk-prompt-view.spec, which asks for the view.
 *
 * Here, apart from index.ts, so it can be tested without Electron.
 */
export function promptViewEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env["PISTACHIO_PROMPT_VIEW"] === "0") return false;
  return env["PISTACHIO_E2E"] !== "1" || env["PISTACHIO_E2E_PROMPT_VIEW"] === "1";
}
