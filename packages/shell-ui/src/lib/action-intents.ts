/**
 * What each chrome action DOES, in a sentence the intent model can read
 * (docs/smart-suggestions.md §4).
 *
 * The fuzzy ranker finds an action by its letters, so its vocabulary
 * (`ACTION_KEYWORDS` in components/address-palette.tsx) is a bag of words:
 * "previous history", "side by side panes". The intent model reads
 * literally and matches MEANING, so it is given what a person would say the
 * action is for: plain, positive, starting with a verb, and never a list of
 * what it is not.
 *
 * Keyed by entry id rather than by `ChromeActionId` so the rows the palette
 * builds by hand (close, restore, clear) sit beside the chrome's own, and
 * so this file imports nothing — it is read by the live accuracy check
 * (test/address-intent.live.test.ts) as well as by the palette.
 * An action with no entry here still reaches the model, by its label alone.
 */
export const ACTION_INTENT_DETAILS: Readonly<Record<string, string>> = {
  "chrome:back": "Go back to the previous page in this tab's history.",
  "chrome:forward": "Go forward to the next page in this tab's history.",
  "chrome:reload": "Reload the page in this tab to refresh its content.",
  "chrome:readerView": "Show this page as clean readable text in reader view.",
  "chrome:copyUrl": "Copy the link of this page to the clipboard to paste or share it.",
  "chrome:copyUrlMarkdown": "Copy the link of this page to the clipboard as a Markdown link with its title.",
  "chrome:newTab": "Open a new empty tab.",
  "chrome:delegate": "Ask the Pistachio agent to work on the page in this tab.",
  "chrome:editAddress": "Edit the address of this tab in the address bar.",
  "chrome:toggleSplit": "Show two tabs side by side in a split view, or return to one.",
  "chrome:toggleConsole": "Open or close the agent chat panel.",
  "chrome:toggleEvidence": "Open or close the evidence panel that replays what the agent did.",
  "chrome:openSettings": "Open the browser's settings.",
  "chrome:openBrief": "Open today's daily brief: a one-page overview of the day's meetings, email waiting for a reply, and to-dos.",
  "chrome:openNotes": "Open the notes you have written: a library of your own markdown documents, kept as you type.",
  "chrome:newNote": "Start writing a new, blank note.",
  "chrome:openReminders": "Open the list of reminders and scheduled tasks.",
  "chrome:openBookmarks": "Open the list of saved bookmarks.",
  "chrome:openArchive": "Open the archive of tabs that were put away and tab groups that were closed, to restore them.",
  "chrome:undoTidy": "Take back the last tidy: reopen the tabs it archived and dissolve the groups it made.",
  "chrome:tidyTabs": "Tidy the open tabs now: archive the ones that are done and group the ones that belong together.",
  "chrome:bookmarkPage": "Save this page as a bookmark.",
  "chrome:openDownloads": "Open the list of downloaded files.",
  "chrome:forkSpace": "Create a new Space branched from this one.",
  "chrome:toggleSidebarPinned": "Keep the sidebar pinned open, or make it compact.",
  "chrome:togglePin": "Pin this tab to the sidebar to keep it, or unpin it.",
  "tab:close-current": "Close the tab you are looking at.",
  "tab:restore-closed": "Reopen the tab that was closed most recently.",
  "tabs:clear-unpinned": "Close every unpinned tab in this Space at once.",
};
