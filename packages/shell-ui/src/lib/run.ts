/**
 * How a run reads, in the renderer.
 *
 * The wording, grouping and tones themselves live in `@pistachio/run-view`,
 * shared with the web run page so the same conversation reads the same way
 * on both devices. What stays here is the one fact only this app can state.
 */

export * from "@pistachio/run-view";

/**
 * The agent is working the page right now — the state the browser surface's
 * chasing ring marks (styles.css, "Agent control"). It lives in shared
 * because main lights the pages themselves on the very same condition, and
 * the two must go out together; the reasoning is documented there.
 */
export { agentIsDriving } from "@pistachio/shell-contracts/agent-glow";
