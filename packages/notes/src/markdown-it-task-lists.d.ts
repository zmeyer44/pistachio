/**
 * `markdown-it-task-lists` ships no types of its own, and markdown-it 15 no
 * longer exports a `Plugin*` helper to borrow, so the plugin is declared here.
 * It stays a plugin rather than a hand-rolled core rule because the rule would
 * have to be kept correct against markdown-it's token stream on every upgrade.
 */
declare module "markdown-it-task-lists" {
  import type { MarkdownIt } from "markdown-it";

  interface TaskListsOptions {
    /** Leave the boxes tickable. Off (the default): a published note is read, not filled in. */
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  export default function taskLists(md: MarkdownIt, options?: TaskListsOptions): void;
}
