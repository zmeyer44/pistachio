/**
 * Whether the desk's windows should be laid out anew — a window came out,
 * one left, or the person asked — as judged by a System One evaluation model
 * (TypeSafe's Jev, through the Vercel AI Gateway: docs/desk-layout.md).
 *
 * The shell offers the moves its geometry allows and describes the windows
 * by title, site and place; the model puts a probability on each move, on
 * which window is the main work, and on which window a new one goes with.
 * The shell — never the model — decides what to do with them
 * (`decideDeskLayout`) and works out where every window goes.
 *
 * Main answers `NativeSurfaceApi.judgeDeskLayout` with the evaluator in
 * @pistachio/agent-runtime/desk-layout, so the wire shapes and the bounds
 * live beside it, and this module is the name the shell says them under.
 * The contract imports nothing from the AI SDK, so the renderer that reads
 * these shapes drags no model code in.
 */

export * from "@pistachio/agent-runtime/desk-layout-contract";
